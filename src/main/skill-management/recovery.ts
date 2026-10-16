import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournal, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectStep, SkillResult } from "../../shared/skill-management-ipc";
import type { Binding } from "../../domain/assignment-plan";
import type { OperationReceipt } from "../../shared/operations-ipc";
import { createUnifiedDiff } from "../../domain/unified-diff";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore, ExactBindingEffect } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import { currentGrantRoot } from "../granted-hashing";
import {
  backupFiles,
  readRegularFile,
  removeFileOrEmptyDirectories,
  safePath,
  writeAtomically,
} from "../operation-files";

type RecoveryFile = Readonly<{
  rootId: string;
  grant: RegistryGrant;
  path: string;
  expectedHash?: string;
  beforeHash?: string;
  before?: Uint8Array;
}>;
type RecoveryStep = Readonly<{
  effect: SkillEffectStep;
  files: readonly RecoveryFile[];
  bindings: readonly ExactBindingEffect[];
}>;
type RecoveryPlan = Readonly<{ original: SkillOperationJournalRecord; steps: readonly RecoveryStep[] }>;
type RecoveryOptions = Readonly<{
  userDataPath: string;
  registry: RegistryIpcServices;
  bindings: BindingsStore;
  operationStore: OperationStore;
  journal: SkillOperationJournal;
}>;

function hash(content: Uint8Array | undefined): string | undefined {
  return content === undefined ? undefined : createHash("sha256").update(content).digest("hex");
}
function sameBinding(left: Binding | undefined, right: Binding | undefined): boolean {
  const entries = (binding: Binding | undefined) =>
    binding ? Object.entries(binding).sort(([a], [b]) => a.localeCompare(b)) : undefined;
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}
async function readFile(root: string, path: string): Promise<Uint8Array | undefined> {
  const location = await safePath(root, path);
  const details = await lstat(location).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (details && (!details.isFile() || details.isSymbolicLink() || details.size > 1024 * 1024))
    throw new Error(`Recovery file is unavailable: ${path}`);
  return readRegularFile(root, path);
}
async function resolveFile(
  args: RecoveryOptions,
  record: SkillOperationJournalRecord,
  step: SkillEffectStep,
  file: SkillEffectStep["files"][number],
): Promise<RecoveryFile> {
  const kind = step.scope.targets.some((target) => target.projectId === file.rootId)
    ? "project"
    : step.scope.sourceId === file.rootId
      ? "source"
      : undefined;
  if (!kind) throw new Error("Recovery file is outside its saved operation scope.");
  const handle = await args.registry.getGrantForEntry({ kind, id: file.rootId });
  const grant = handle ? args.registry.get(handle) : undefined;
  if (!grant || !(await currentGrantRoot(grant))) throw new Error(`Reconnect the recovery ${kind}: ${file.rootId}`);
  const current = await readFile(grant.root, file.relativePath);
  const currentHash = hash(current);
  if (currentHash !== file.beforeHash && currentHash !== file.afterHash)
    throw new Error(`Recovery file changed locally: ${file.relativePath}`);
  let before = currentHash === file.beforeHash ? current : undefined;
  if (file.beforeHash && before === undefined) {
    for (const reference of record.backupReferences.filter((candidate) => candidate.rootId === file.rootId)) {
      const backupRoot = await safePath(args.userDataPath, `omni/${reference.path}`);
      const exists = await lstat(backupRoot).catch(() => undefined);
      if (!exists) continue;
      if (!exists.isDirectory() || exists.isSymbolicLink())
        throw new Error("Recovery backup must be a regular directory.");
      const saved = await readFile(backupRoot, file.relativePath);
      if (hash(saved) === file.beforeHash) {
        before = saved;
        break;
      }
    }
    if (before === undefined) throw new Error(`The verified recovery backup is unavailable: ${file.relativePath}`);
  }
  return {
    rootId: file.rootId,
    grant,
    path: file.relativePath,
    expectedHash: currentHash,
    beforeHash: file.beforeHash,
    ...(before === undefined ? {} : { before }),
  };
}
async function buildRecovery(
  args: RecoveryOptions,
  record: SkillOperationJournalRecord,
  planId: string,
): Promise<RecoveryPlan> {
  if (!record.effect) throw new Error("Saved recovery effects are unavailable.");
  const loaded = await args.bindings.read();
  if (loaded.status !== "ready") throw new Error("The bindings store is unavailable for recovery.");
  const steps: RecoveryStep[] = [];
  for (const [index, original] of [...record.effect.steps].reverse().entries()) {
    const files = await Promise.all(original.files.map((file) => resolveFile(args, record, original, file)));
    const bindings = original.bindingEffects.map((effect) => {
      const current = loaded.bindings.find((candidate) => candidate.bindingId === effect.bindingId);
      if (!sameBinding(current, effect.before) && !sameBinding(current, effect.after))
        throw new Error(`Recovery binding changed locally: ${effect.bindingId}`);
      return {
        bindingId: effect.bindingId,
        ...(current ? { expected: current } : {}),
        ...(effect.before ? { next: effect.before } : {}),
      };
    });
    const summaries = files.map((file) => ({
      rootId: file.rootId,
      relativePath: file.path,
      change:
        file.expectedHash === file.beforeHash
          ? ("unchanged" as const)
          : file.beforeHash === undefined
            ? ("delete" as const)
            : file.expectedHash === undefined
              ? ("add" as const)
              : ("change" as const),
      ...(file.expectedHash ? { beforeHash: file.expectedHash } : {}),
      ...(file.beforeHash ? { afterHash: file.beforeHash } : {}),
    }));
    const actions = summaries
      .filter((file) => file.change !== "unchanged")
      .map((file) => ({
        kind: file.change === "delete" ? ("delete-file" as const) : ("write-file" as const),
        relativePath: file.relativePath,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
      }));
    const effect: SkillEffectStep = {
      ...original,
      stepId: `${planId}-${index}`,
      files: summaries,
      bindingEffects: bindings.map((binding) => ({
        bindingId: binding.bindingId,
        ...(binding.expected ? { before: binding.expected } : {}),
        ...(binding.next ? { after: binding.next } : {}),
      })),
      plan: {
        planId: `${planId}-${index}`,
        kind: original.scope.targets.length ? "restore-apply" : "restore-import",
        displayTarget: original.plan.displayTarget,
        actions,
        git: { mode: "unavailable", warnings: [] },
      },
    };
    steps.push({ effect, files, bindings });
  }
  return { original: record, steps };
}
function savedPlan(plans: Map<string, RecoveryPlan>, planId: string): RecoveryPlan {
  const plan = plans.get(planId);
  if (!plan) throw new Error("The recovery preview expired; refresh it before applying.");
  return plan;
}
async function checkUnchanged(args: RecoveryOptions, plan: RecoveryPlan): Promise<void> {
  const current = await args.bindings.read();
  if (current.status !== "ready") throw new Error("Recovery bindings are unavailable.");
  for (const step of plan.steps) {
    for (const file of step.files) {
      if (
        !(await currentGrantRoot(file.grant)) ||
        hash(await readFile(file.grant.root, file.path)) !== file.expectedHash
      )
        throw new Error(`Recovery file changed after preview: ${file.path}`);
    }
    for (const binding of step.bindings) {
      if (
        !sameBinding(
          current.bindings.find((candidate) => candidate.bindingId === binding.bindingId),
          binding.expected,
        )
      )
        throw new Error(`Recovery binding changed after preview: ${binding.bindingId}`);
    }
  }
}

export function createSkillRecoveryAdapter(args: RecoveryOptions): Readonly<{
  preview(record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const plans = new Map<string, RecoveryPlan>();
  const preview = async (record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild> => {
    try {
      const planId = randomUUID();
      const plan = await buildRecovery(args, record, planId);
      const steps = await Promise.all(
        plan.steps.map(async (step) => ({
          ...step.effect,
          files: await Promise.all(
            step.effect.files.map(async (file, index) => {
              if (file.change === "unchanged") return file;
              const saved = step.files[index];
              const diff = createUnifiedDiff(
                `${saved.path} (observed)`,
                `${saved.path} (before operation)`,
                (await readFile(saved.grant.root, saved.path)) ?? new Uint8Array(),
                saved.before ?? new Uint8Array(),
              );
              return {
                ...file,
                ...(diff ? { diff: diff.text } : { summary: "Binary recovery file; verified hashes are shown." }),
              };
            }),
          ),
        })),
      );
      const scope = record.effect!.scope;
      const backupReferences = [...new Set(plan.steps.flatMap((step) => step.files.map((file) => file.rootId)))].map(
        (rootId) => ({ rootId, path: `backups/skill-recovery/${intentId}/${rootId}` }),
      );
      plans.set(planId, plan);
      return {
        status: "ready",
        planId,
        scope,
        steps,
        fingerprint: {
          scope,
          files: steps.flatMap((step) => step.files),
          bindings: steps.flatMap((step) => step.bindingEffects),
        },
        backupReferences,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Recovery could not be inspected safely.";
      return {
        status: "blocked",
        reason: message,
        details: [
          {
            code: message.includes("changed") ? "recovery-drift" : "recovery-unavailable",
            message,
            recoveryAction: "inspect-recovery",
          },
        ],
      };
    }
  };
  const prepare = async (intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const plan = savedPlan(plans, effect.planId);
    await checkUnchanged(args, plan);
    for (const step of plan.steps)
      for (const file of step.files) {
        const root = join(args.userDataPath, "omni/backups/skill-recovery", intentId, file.rootId);
        await mkdir(root, { recursive: true, mode: 0o700 });
        if (file.expectedHash) {
          await backupFiles(file.grant.root, root, [file.path]);
          await chmod(await safePath(root, file.path), 0o600);
        }
      }
  };
  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const plan = savedPlan(plans, effect.planId);
    await checkUnchanged(args, plan);
    const receipts: OperationReceipt[] = [];
    const targets: SkillResult["targets"][number][] = [];
    for (const [index, step] of plan.steps.entries()) {
      const stepId = effect.steps[index].stepId;
      await progress({ stepId, status: "applying" });
      for (const file of step.files) {
        if (hash(await readFile(file.grant.root, file.path)) !== file.expectedHash)
          throw new Error(`Recovery file changed during apply: ${file.path}`);
        if (file.expectedHash === file.beforeHash) continue;
        if (file.before === undefined) await removeFileOrEmptyDirectories(file.grant.root, file.path, ".");
        else await writeAtomically(file.grant.root, file.path, file.before);
      }
      if (step.bindings.length) {
        const updated = await args.bindings.updateExact(
          step.bindings.filter((binding) => binding.expected || binding.next),
        );
        if (updated.status !== "ready") throw new Error("Recovery bindings could not be saved.");
      }
      for (const file of step.files)
        if (hash(await readFile(file.grant.root, file.path)) !== file.beforeHash)
          throw new Error(`Recovery verification failed: ${file.path}`);
      const projectId = step.effect.scope.targets[0]?.projectId;
      const receipt: OperationReceipt = {
        operationId: randomUUID(),
        kind: step.effect.plan.kind,
        status: "applied",
        appliedAt: new Date().toISOString(),
        displayTarget: step.effect.plan.displayTarget,
        actions: step.effect.plan.actions.map((action) => ({ ...action, status: "applied" })),
        registered: step.effect.scope.sourceId ? { sourceId: step.effect.scope.sourceId } : null,
        ...(projectId ? { project: { id: projectId } } : {}),
        git: { mode: "unavailable" },
        restores: plan.original.intentId,
        bindings: step.bindings.map((binding) => ({
          bindingId: binding.bindingId,
          before: binding.expected,
          after: binding.next,
        })),
      };
      const stored = await args.operationStore.append(receipt);
      if (stored.status !== "ready") throw new Error("The recovery receipt could not be saved.");
      receipts.push(receipt);
      await progress({ stepId, status: "applied", receiptId: receipt.operationId });
      targets.push(
        ...step.effect.bindingEffects.flatMap((bindingEffect) => {
          const binding = bindingEffect.before ?? bindingEffect.after;
          return binding
            ? [
                {
                  projectId: binding.projectId,
                  harnessId: binding.harnessId,
                  bindingId: binding.bindingId,
                  artifactPath: binding.artifactPath,
                  status: "restored" as const,
                },
              ]
            : [];
        }),
      );
    }
    const source: SkillResult["source"] = {
      status: plan.original.intent.kind === "write" ? "restored" : "unchanged",
      ...(effect.scope.sourceId ? { sourceId: effect.scope.sourceId } : {}),
    };
    const result: SkillResult = {
      intentId: plan.original.intentId,
      operationId: plan.original.intentId,
      status: "restored",
      source,
      targets,
      receiptIds: receipts.map((receipt) => receipt.operationId),
      issues: [],
      recoveryAvailable: false,
    };
    // Retire only after every scoped file and exact binding reversal has been verified.
    const stored = await args.operationStore.append({
      operationId: plan.original.intentId,
      kind: "skill-management",
      status: "applied",
      appliedAt: plan.original.createdAt,
      displayTarget: plan.original.effect?.scope.packageId ?? "Skill operation",
      actions: [],
      git: { mode: "unavailable" },
      registered: null,
      children: result.receiptIds,
      skillManagement: result,
      restored: true,
    });
    if (stored.status !== "ready") throw new Error("The verified recovery summary could not be saved.");
    for (const step of plan.original.steps)
      if (step.receiptId) {
        const marked = await args.operationStore.markRestored(step.receiptId);
        if (marked.status !== "ready") throw new Error("The scoped recovery receipt could not be saved.");
      }
    await args.journal.write({
      ...plan.original,
      status: "terminal",
      result,
      updatedAt: new Date().toISOString(),
      steps: plan.original.steps.map((step) => ({ ...step, status: "applied" })),
    });
    return { ...result, receipts };
  };
  return { preview, prepare, apply, has: (planId) => plans.has(planId) };
}
