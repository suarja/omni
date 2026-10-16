import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  planAssignment,
  type AssignmentAction,
  type Binding,
  type ProjectPlan,
  type TargetEvidence,
} from "../domain/assignment-plan";
import { createUnifiedDiff } from "../domain/unified-diff";
import type { ApplyPreviewAction, ApplyPreviewResponse, ApplyRunRequest } from "../shared/apply-ipc";
import type { OperationActionReceipt, OperationApplyProvenance, OperationReceipt } from "../shared/operations-ipc";
import type { Settings } from "../shared/settings-ipc";
import type { RegistryGrant } from "./registry-ipc";
import type { BindingsStore } from "./bindings-store";
import type { OperationStore } from "./operation-store";
import type { GitCli } from "./git-cli";
import { observeTarget, resolveUnitFromGrant, type ResolvedUnit } from "./assignment-resolution";
import {
  backupFiles,
  listRegularFiles,
  removeFileOrEmptyDirectories,
  restoreBackup,
  writeAtomically,
  type FileWriter,
} from "./operation-files";
import { hashGrantedPath, resolveGrantedPath } from "./granted-hashing";
import { createSkillRelationshipStore } from "./skill-reconciliation/store";
import { assertLegacyBindingsUnmanaged } from "./skill-management/legacy-binding-guard";

type UnitAction = Readonly<{
  actionId: string;
  action: AssignmentAction;
  plan: ProjectPlan;
  binding: Binding;
  unit: ResolvedUnit;
  target: TargetEvidence;
  projectGrant: RegistryGrant;
}>;
export type ApplyPlan = Readonly<{
  planId: string;
  projectId: string;
  displayName: string;
  projectRoot: string;
  projectGrant: RegistryGrant;
  actions: readonly UnitAction[];
  response: ApplyPreviewResponse;
  settings: Settings;
}>;
export type ApplyEngineOptions = Readonly<{
  userDataPath: string;
  bindingsStore: BindingsStore;
  operationStore: OperationStore;
  git: GitCli;
  settings: Settings;
  fileWriter?: FileWriter;
  now?: () => number;
  provenance?: OperationApplyProvenance;
}>;

function planKey(binding: Binding): string {
  return `${binding.sourceId}\n${binding.packageId}\n${binding.artifactPath}\n${binding.kind}`;
}

function sameBindingUnit(left: Binding, right: Binding): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.packageId === right.packageId &&
    left.artifactPath === right.artifactPath &&
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    left.harnessId === right.harnessId
  );
}

function sameBindingRecord(left: Binding | undefined, right: Binding | undefined): boolean {
  if (!left || !right) return left === right;
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function hashPlan(plans: readonly ProjectPlan[]): string {
  return createHash("sha256").update(JSON.stringify(plans), "utf8").digest("hex");
}

function harnessName(harness: string): string {
  return harness === "claude-code" ? "Claude Code" : harness === "codex" ? "Codex" : "Cursor";
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pluralUnitKind(kind: AssignmentAction["kind"]): string {
  return kind === "skill"
    ? "skills"
    : kind === "command"
      ? "commands"
      : kind === "agent"
        ? "agents"
        : kind === "hook"
          ? "hooks"
          : kind === "mcp-config"
            ? "MCP configs"
            : "instructions";
}

export function assignmentCommitMessage(
  verb: "Add" | "Update" | "Remove" | "Restore",
  units: readonly string[],
  harnesses: readonly string[],
  kind: AssignmentAction["kind"] = "skill",
): string {
  const subject = units.length > 3 ? `${units.length} ${pluralUnitKind(kind)}` : units.join(", ");
  return `${verb} ${subject || "assignment"} for ${harnesses.join(" and ")}`;
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "Apply operation failed safely.";
  return message.length <= 240 && !/[\r\n]/.test(message) && !/(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(message)
    ? message
    : "Apply operation failed safely.";
}

function targetFile(action: AssignmentAction, relativePath: string): string {
  return relativePath ? `${action.relativePath}/${relativePath}` : action.relativePath;
}

async function diffForAction(projectGrant: RegistryGrant, item: UnitAction): Promise<ApplyPreviewAction["diff"]> {
  if (item.action.state !== "conflict") return undefined;
  const diffs: string[] = [];
  for (const file of item.unit.files) {
    const relativePath = targetFile(item.action, file.relativePath);
    const target = await resolveGrantedPath(projectGrant, relativePath);
    const before =
      target === "denied" || target === "unavailable"
        ? Buffer.alloc(0)
        : await readFile(target).catch(() => Buffer.alloc(0));
    diffs.push(
      createUnifiedDiff(`${relativePath} (project)`, `${relativePath} (marketplace)`, before, file.content).text,
    );
  }
  const combined = diffs.join("\n");
  if (Buffer.byteLength(combined, "utf8") <= 64 * 1024) return { kind: "unified", text: combined, truncated: false };
  let text = combined;
  while (text && Buffer.byteLength(text, "utf8") > 64 * 1024) text = text.slice(0, -1);
  return { kind: "unified", text, truncated: true };
}

async function gitPreview(git: GitCli, settings: Settings, root: string): Promise<ApplyPreviewResponse["git"]> {
  if (!settings.git.commitChanges) return { mode: "disabled" };
  if (!(await git.isGitAvailable())) return { mode: "unavailable" };
  if (!(await git.isRepositoryRoot(root))) return { mode: "not-a-repository" };
  const head = await git.headCommit(root);
  return head ? { mode: "commit", head } : { mode: "commit" };
}

export async function buildApplyPlan(
  args: Readonly<{
    projectId: string;
    displayName: string;
    projectGrant: RegistryGrant;
    sourceGrant: RegistryGrant;
    bindings: readonly Binding[];
    settings: Settings;
    git: GitCli;
  }>,
): Promise<ApplyPlan> {
  const grouped = new Map<string, Binding[]>();
  for (const binding of args.bindings.filter((candidate) => candidate.projectId === args.projectId)) {
    const key = planKey(binding);
    grouped.set(key, [...(grouped.get(key) ?? []), binding]);
  }
  const actions: UnitAction[] = [];
  const plans: ProjectPlan[] = [];
  for (const group of grouped.values()) {
    const first = group[0]!;
    const resolved = await resolveUnitFromGrant(args.sourceGrant, first.packageId, first.artifactPath);
    if (!resolved) throw new Error("Marketplace unit is unavailable.");
    const targets = await Promise.all(
      group.map((binding) => observeTarget(args.projectGrant, resolved.unit, binding.harnessId)),
    );
    const plan = planAssignment({
      unit: resolved.unit,
      project: { projectId: args.projectId, targets },
      bindings: group,
    });
    plans.push(plan);
    for (const action of plan.actions) {
      const binding = group.find((candidate) => candidate.bindingId === action.bindingId)!;
      const target = targets.find(
        (candidate) => candidate.harnessId === action.harnessId && candidate.relativePath === action.relativePath,
      )!;
      actions.push({
        actionId: `${hashPlan([plan]).slice(0, 24)}:${action.bindingId}`,
        action,
        plan,
        binding,
        unit: resolved,
        target,
        projectGrant: args.projectGrant,
      });
    }
  }
  const planId = hashPlan(plans);
  const responseActions: ApplyPreviewAction[] = [];
  for (const item of actions) {
    const diff = await diffForAction(args.projectGrant, item);
    responseActions.push({
      actionId: item.actionId,
      bindingId: item.binding.bindingId,
      harnessId: item.action.harnessId,
      kind: item.action.kind,
      relativePath: item.action.relativePath,
      state: item.action.state,
      ...(item.action.reason ? { reason: item.action.reason } : {}),
      needsResolution: item.action.state === "conflict",
      ...(diff ? { diff } : {}),
    });
  }
  return {
    planId,
    projectId: args.projectId,
    displayName: args.displayName,
    projectRoot: args.projectGrant.root,
    projectGrant: args.projectGrant,
    actions,
    response: {
      status: "ready",
      planId,
      project: { displayName: args.displayName },
      actions: responseActions,
      git: await gitPreview(args.git, args.settings, args.projectGrant.root),
    },
    settings: args.settings,
  };
}

async function targetHash(grant: RegistryGrant, relativePath: string): Promise<string | undefined> {
  const result = await hashGrantedPath(grant, relativePath);
  return result.status === "hashed" ? result.contentHash : undefined;
}

async function backupTarget(
  item: UnitAction,
  operationId: string,
  options: ApplyEngineOptions,
): Promise<Readonly<{ relativePath: string; previousHash?: string }>[]> {
  const targetFiles = item.unit.unit.files
    ? await listRegularFiles(item.projectGrant.root, item.action.relativePath)
    : [item.action.relativePath];
  const backupRoot = join(options.userDataPath, "omni/backups", operationId, item.binding.projectId);
  await backupFiles(item.projectGrant.root, backupRoot, targetFiles);
  const previous: { relativePath: string; previousHash?: string }[] = [];
  for (const file of item.unit.files) {
    const relativePath = targetFile(item.action, file.relativePath);
    const previousHash = await targetHash(item.projectGrant, relativePath);
    previous.push({ relativePath, ...(previousHash ? { previousHash } : {}) });
  }
  return previous;
}

async function applyFiles(
  item: UnitAction,
  operationId: string,
  options: ApplyEngineOptions,
  onWrite: (record: { relativePath: string; contentHash: string; previousHash?: string }) => void,
): Promise<void> {
  const previous =
    item.action.state === "update" || item.action.state === "conflict"
      ? await backupTarget(item, operationId, options)
      : [];
  for (const file of item.unit.files) {
    const relativePath = targetFile(item.action, file.relativePath);
    const previousHash = previous.find((candidate) => candidate.relativePath === relativePath)?.previousHash;
    await writeAtomically(item.projectGrant.root, relativePath, file.content, options.fileWriter);
    const record = { relativePath, contentHash: file.contentHash, ...(previousHash ? { previousHash } : {}) };
    onWrite(record);
  }
  const actual = await targetHash(item.projectGrant, item.action.relativePath);
  if (actual !== item.unit.unit.contentHash) throw new Error("Apply verification did not match the marketplace hash.");
}

async function rollback(
  operationId: string,
  projectRoot: string,
  projectId: string,
  records: readonly { relativePath: string; previousHash?: string }[],
  options: ApplyEngineOptions,
): Promise<void> {
  const backupRoot = join(options.userDataPath, "omni/backups", operationId, projectId);
  for (const record of [...records].reverse()) {
    if (record.previousHash) await restoreBackup(projectRoot, backupRoot, record.relativePath);
    else await removeFileOrEmptyDirectories(projectRoot, record.relativePath, ".").catch(() => undefined);
  }
}

function receiptActions(
  files: readonly { relativePath: string }[],
  status: OperationActionReceipt["status"],
): readonly OperationActionReceipt[] {
  return files.map((file) => ({ kind: "write-file", relativePath: file.relativePath, status }));
}

function changedItems(
  plan: ApplyPlan,
  resolutions: ReadonlyMap<string, ApplyRunRequest["resolutions"][number]["choice"]>,
): readonly UnitAction[] {
  return plan.actions.filter(
    (item) =>
      item.action.state === "add" ||
      item.action.state === "update" ||
      resolutions.get(item.actionId) === "take-marketplace",
  );
}

function unitNames(items: readonly UnitAction[]): readonly string[] {
  return orderedUnique(items.map((item) => item.unit.unit.id));
}

function harnessNames(items: readonly UnitAction[]): readonly string[] {
  return orderedUnique(items.map((item) => harnessName(item.action.harnessId)));
}

function updatedBinding(item: UnitAction, ownedHash: string): Binding {
  return { ...item.binding, boundHash: item.unit.unit.contentHash, ownedHash };
}

export async function executeApply(
  plan: ApplyPlan,
  request: ApplyRunRequest,
  options: ApplyEngineOptions,
): Promise<{ status: "applied" | "failed"; receipt: OperationReceipt }> {
  await assertLegacyBindingsUnmanaged(
    plan.actions.map(({ binding }) => binding),
    createSkillRelationshipStore(join(options.userDataPath, "omni", "skill-relationships.json")),
  );
  const operationId = randomUUID();
  const written: { relativePath: string; contentHash: string; previousHash?: string }[] = [];
  const bindingUpdates = new Map<string, Binding>();
  const previousBindings = new Map<string, Binding | undefined>();
  let bindingsCaptured = false;
  let bindingEffects: { bindingId: string; before?: Binding; after?: Binding }[] = [];
  let bindingSaveAttempted = false;
  const resolutions = new Map(request.resolutions.map((resolution) => [resolution.actionId, resolution.choice]));
  const changed = changedItems(plan, resolutions);
  const plannedUnits = unitNames(plan.actions);
  try {
    const loadedBindings = await options.bindingsStore.read();
    if (loadedBindings.status !== "ready") throw new Error("Bindings could not be read safely before apply.");
    for (const item of plan.actions) {
      const prior =
        loadedBindings.bindings.find((binding) => binding.bindingId === item.binding.bindingId) ??
        loadedBindings.bindings.find((binding) => sameBindingUnit(binding, item.binding));
      previousBindings.set(item.binding.bindingId, prior);
    }
    bindingsCaptured = true;
    for (const item of plan.actions) {
      const choice = resolutions.get(item.actionId);
      if (item.action.state === "conflict" && !choice) throw new Error("A conflict requires an explicit resolution.");
      if (item.action.state === "blocked") throw new Error(item.action.reason ?? "Apply is blocked.");
      if (choice === "keep-mine") {
        const ownedHash = item.target.contentHash;
        if (!ownedHash) throw new Error("The local target hash is unavailable.");
        bindingUpdates.set(item.binding.bindingId, updatedBinding(item, ownedHash));
      } else if (item.action.state === "add" || item.action.state === "update" || choice === "take-marketplace") {
        await applyFiles(item, operationId, options, (record) => written.push(record));
        bindingUpdates.set(item.binding.bindingId, updatedBinding(item, item.unit.unit.contentHash));
      } else if (item.action.state === "current" || item.action.state === "linked") {
        bindingUpdates.set(item.binding.bindingId, {
          ...item.binding,
          boundHash: item.unit.unit.contentHash,
          ownedHash: item.unit.unit.contentHash,
        });
      }
    }
    bindingEffects = [...bindingUpdates].map(([bindingId, after]) => {
      const before = previousBindings.get(bindingId);
      return { bindingId, ...(before ? { before } : {}), after };
    });
    const paths = [...new Set(written.map((file) => file.relativePath))];
    const gitMode = plan.response.git.mode;
    const headBefore = gitMode === "commit" ? await options.git.headCommit(plan.projectRoot) : undefined;
    let commit: string | undefined;
    if (gitMode === "commit" && paths.length && (await options.git.hasChanges(plan.projectRoot, paths))) {
      const verb = changed.every((item) => item.action.state === "add") ? "Add" : "Update";
      const result = await options.git.commitAll(
        plan.projectRoot,
        assignmentCommitMessage(verb, plannedUnits, harnessNames(plan.actions), plan.actions[0]?.unit.unit.kind),
        paths,
      );
      if (result.status !== "committed") throw new Error(result.diagnostic);
      commit = result.commit;
    }
    bindingSaveAttempted = true;
    const saved = await options.bindingsStore.updateExact(
      bindingEffects.map((effect) => ({
        bindingId: effect.bindingId,
        ...(effect.before ? { expected: effect.before } : {}),
        ...(effect.after ? { next: effect.after } : {}),
      })),
    );
    if (saved.status !== "ready") throw new Error("Bindings could not be persisted safely.");
    const receipt: OperationReceipt = {
      operationId,
      kind: "apply-plan",
      status: "applied",
      appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
      displayTarget: plan.displayName,
      actions: receiptActions(written, "applied"),
      git: {
        mode: gitMode,
        ...(commit ? { commit } : {}),
        ...(headBefore ? { headBefore } : {}),
        ...(commit ? { headAfter: commit } : {}),
      },
      registered: null,
      project: { id: plan.projectId },
      bindings: bindingEffects.map((effect) => ({
        bindingId: effect.bindingId,
        ...(effect.before?.ownedHash ? { previousOwnedHash: effect.before.ownedHash } : {}),
        ...(effect.before ? { binding: effect.before, before: effect.before } : {}),
        ...(effect.after ? { after: effect.after } : {}),
      })),
      files: written,
      units: plannedUnits,
      ...(options.provenance ? { provenance: options.provenance } : {}),
    };
    const stored = await options.operationStore.append(receipt);
    if (stored.status !== "ready") throw new Error("Apply receipt could not be persisted safely.");
    return { status: "applied", receipt };
  } catch (error: unknown) {
    await rollback(operationId, plan.projectRoot, plan.projectId, written, options).catch(() => undefined);
    let bindingRollbackFailed = false;
    if (bindingsCaptured && bindingSaveAttempted) {
      try {
        const current = await options.bindingsStore.read();
        if (current.status !== "ready") throw new Error("Bindings are unavailable during rollback.");
        const rollbackEffects = [];
        for (const effect of bindingEffects) {
          const existing = current.bindings.find((binding) => binding.bindingId === effect.bindingId);
          if (sameBindingRecord(existing, effect.after)) {
            rollbackEffects.push({
              bindingId: effect.bindingId,
              ...(effect.after ? { expected: effect.after } : {}),
              ...(effect.before ? { next: effect.before } : {}),
            });
          } else if (!sameBindingRecord(existing, effect.before)) {
            bindingRollbackFailed = true;
          }
        }
        if (rollbackEffects.length) {
          const restored = await options.bindingsStore.updateExact(rollbackEffects);
          if (restored.status !== "ready") bindingRollbackFailed = true;
        }
      } catch {
        bindingRollbackFailed = true;
      }
    }
    const receipt: OperationReceipt = {
      operationId,
      kind: "apply-plan",
      status: "failed",
      appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
      displayTarget: plan.displayName,
      actions: receiptActions(written, "rolled-back"),
      git: { mode: plan.response.git.mode },
      registered: null,
      project: { id: plan.projectId },
      diagnostic: bindingRollbackFailed
        ? "The assignment failed and its binding records could not all be restored. Inspect recovery before retrying."
        : safeDiagnostic(error),
      units: plannedUnits,
      ...(bindingsCaptured
        ? {
            bindings: bindingEffects.map((effect) => ({
              bindingId: effect.bindingId,
              ...(effect.before?.ownedHash ? { previousOwnedHash: effect.before.ownedHash } : {}),
              ...(effect.before ? { binding: effect.before, before: effect.before } : {}),
              ...(effect.after ? { after: effect.after } : {}),
            })),
          }
        : {}),
      ...(options.provenance ? { provenance: options.provenance } : {}),
    };
    await options.operationStore.append(receipt).catch(() => undefined);
    return { status: "failed", receipt };
  }
}
