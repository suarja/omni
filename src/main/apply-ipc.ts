import { activeWorkshop, isWorkshopSource } from "../domain/source-roles";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { app, ipcMain } from "electron";

import type { Binding } from "../domain/assignment-plan";
import { resolveTarget } from "../domain/harness-targets";
import { createLocalJsonRegistryStore } from "../adapters/registry/local-json";
import type {
  ApplyBlockedResponse,
  ApplyPreviewRequest,
  ApplyPreviewResponse,
  ApplyRunRequest,
  ApplyRunResponse,
  RemovePreviewAction,
  RemovePreviewRequest,
  RemovePreviewResponse,
  RemoveRunRequest,
  RestorePreviewResponse,
} from "../shared/apply-ipc";
import {
  APPLY_IPC_CHANNELS,
  parseApplyPreviewRequest,
  parseApplyRunRequest,
  parseRemovePreviewRequest,
  parseRemoveRunRequest,
  parseRestorePreviewRequest,
  parseRestoreRunRequest,
  type RestoreRunRequest,
} from "../shared/apply-ipc";
import type { RegistryState } from "../domain/project-source-registry";
import type { SettingsStore } from "./settings-store";
import { createSettingsStore, settingsFilePath } from "./settings-store";
import type { RegistryGrant, RegistryGrantStore } from "./registry-ipc";
import { isGrantedTargetAbsent } from "./granted-target-absence";
import { currentGrantRoot, hashGrantedPath, resolveGrantedPath } from "./granted-hashing";
import {
  activeRegistration,
  grantFor,
  observeTarget,
  resolveUnitFromGrant,
  resolveUnitFromRoot,
  type ResolvedUnit,
} from "./assignment-resolution";
import {
  backupFiles,
  listRegularFiles,
  removeFileOrEmptyDirectories,
  restoreBackup,
  type FileWriter,
} from "./operation-files";
import { bindingsFilePath, createBindingsStore, type BindingsStore } from "./bindings-store";
import { createOperationStore, type OperationStore } from "./operation-store";
import { systemGitCli, type GitCli } from "./git-cli";
import {
  assignmentCommitMessage,
  buildApplyPlan,
  executeApply,
  type ApplyEngineOptions,
  type ApplyPlan,
} from "./apply-engine";
import type { OperationReceipt } from "../shared/operations-ipc";
import type { OperationPlan } from "../shared/operations-ipc";
import { buildManagedAssignmentPreview } from "./skill-management/assignment-preview";
import { createSkillRelationshipStore } from "./skill-reconciliation/store";
import { assertLegacyBindingsUnmanaged } from "./skill-management/legacy-binding-guard";
import type { SkillBindingEffect, SkillFileSummary } from "../shared/skill-management-ipc";
import {
  safeError,
  registryState,
  internalGrant,
  expired,
  blocked,
  harnessName,
  harnessesFromPaths,
  engineOptions,
  targetFile,
  currentTargetFiles,
  removalFiles,
  removalPreviewDiffs,
  RemoveTargetError,
  gitMode,
  removeStopPath,
  type ApplyIpcOptions,
  type Clock,
  type RemoveFile,
  type SenderGuard,
  type StoredApply,
  type StoredRemove,
  type StoredRestore,
} from "./apply-ipc-helpers";

export type ApplyRestoreBridge = Readonly<{
  onAssignmentCompleted?(handler: () => Promise<void>): void;
  previewRemove(raw: RemovePreviewRequest): Promise<RemovePreviewResponse | ApplyBlockedResponse>;
  runRemove(raw: RemoveRunRequest): Promise<ApplyRunResponse | ApplyBlockedResponse>;
  previewRestore(raw: unknown): Promise<RestorePreviewResponse | ApplyBlockedResponse>;
  runRestore(raw: unknown): Promise<ApplyRunResponse | ApplyBlockedResponse>;
  previewManagedAssignment(request: ManagedAssignmentRequest): Promise<ManagedAssignmentPreview | ApplyBlockedResponse>;
  prepareManagedAssignment(planId: string, intentId: string): Promise<readonly string[]>;
  runManagedAssignment(planId: string): Promise<ApplyRunResponse | ApplyBlockedResponse>;
}>;

export type ManagedAssignmentPreview = Readonly<{
  planId: string;
  plan: OperationPlan;
  files: readonly SkillFileSummary[];
  bindingEffects: readonly SkillBindingEffect[];
  noOp: boolean;
}>;

export type ManagedAssignmentRequest = Readonly<{
  projectId: string;
  sourceId: string;
  packageId: string;
  artifactPath?: string;
  sourceGrantHandle: string;
  projectGrantHandle: string;
  bindings: readonly Binding[];
}>;
type StoredManagedAssignment = Readonly<{ plan: ApplyPlan; request: ManagedAssignmentRequest; expiresAt: number }>;

function sameBindingRecord(left: Binding | undefined, right: Binding | undefined): boolean {
  if (!left || !right) return left === right;
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export function registerApplyIpcHandlers(
  assertTrustedSender: SenderGuard,
  grants: RegistryGrantStore,
  options: ApplyIpcOptions = {},
): ApplyRestoreBridge {
  let assignmentCompleted: (() => Promise<void>) | undefined;
  const completeAssignment = async (result: Awaited<ReturnType<typeof executeApply>>): Promise<ApplyRunResponse> => {
    if (result.status === "applied") await assignmentCompleted?.();
    return result;
  };
  const userDataPath = options.userDataPath ?? app.getPath("userData");
  const bindingsStore = options.bindingsStore ?? createBindingsStore(bindingsFilePath(userDataPath));
  const operationStore = options.operationStore ?? createOperationStore(join(userDataPath, "omni/operations.json"));
  const settingsStore = options.settingsStore ?? createSettingsStore(settingsFilePath(userDataPath));
  const git = options.gitCli ?? systemGitCli;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const applyPlans = new Map<string, StoredApply>();
  const managedAssignmentPlans = new Map<string, StoredManagedAssignment>();
  const removePlans = new Map<string, StoredRemove>();
  const restorePlans = new Map<string, StoredRestore>();
  const prune = (): void => {
    for (const [id, stored] of applyPlans) if (expired(stored.expiresAt, now)) applyPlans.delete(id);
    for (const [id, stored] of removePlans) if (expired(stored.expiresAt, now)) removePlans.delete(id);
    for (const [id, stored] of restorePlans) if (expired(stored.expiresAt, now)) restorePlans.delete(id);
  };
  const guard =
    <T>(handler: (request: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, request: unknown): Promise<T> => {
      assertTrustedSender(event);
      try {
        prune();
        return await handler(request);
      } catch (error: unknown) {
        throw new Error(safeError(error));
      }
    };

  const build = async (request: ApplyPreviewRequest): Promise<ApplyPlan | ApplyBlockedResponse> => {
    const state = await registryState(userDataPath);
    const project = activeRegistration(state, "project", request.projectId);
    const source = activeWorkshop(state);
    if (!project || !source) return blocked("entry-unavailable", "The project or personal marketplace is not active.");
    const projectGrant = grantFor(grants, { kind: "project", id: request.projectId }, request.grantHandle);
    const sourceGrant = grantFor(grants, { kind: "source", id: source.id }, request.sourceGrantHandle);
    if (
      !projectGrant ||
      !sourceGrant ||
      !(await currentGrantRoot(projectGrant)) ||
      !(await currentGrantRoot(sourceGrant))
    )
      return blocked("grant-invalid");
    const loaded = await bindingsStore.read();
    if (loaded.status !== "ready") return blocked("bindings-unavailable");
    let selectedBindings = loaded.bindings;
    if (request.bindingIds) {
      const selected = new Set(request.bindingIds);
      const matches = loaded.bindings.filter((binding) => selected.has(binding.bindingId));
      if (matches.length !== selected.size)
        return blocked("binding-unavailable", "A selected assignment is unavailable.");
      if (matches.some((binding) => binding.projectId !== request.projectId))
        return blocked("binding-project-mismatch", "A selected assignment belongs to another project.");
      selectedBindings = matches;
    }
    try {
      await assertLegacyBindingsUnmanaged(
        selectedBindings.filter(({ projectId }) => projectId === request.projectId),
        createSkillRelationshipStore(join(userDataPath, "omni", "skill-relationships.json")),
      );
    } catch (error: unknown) {
      return blocked("managed-copy", safeError(error));
    }
    const settings = await settingsStore.read();
    return buildApplyPlan({
      projectId: request.projectId,
      displayName: project.displayName,
      projectGrant,
      sourceGrant,
      bindings: selectedBindings,
      settings,
      git,
    });
  };

  const previewApply = async (raw: unknown) => {
    const request = parseApplyPreviewRequest(raw);
    const result = await build(request);
    if ("status" in result) return result;
    applyPlans.set(result.planId, { plan: result, request, expiresAt: now() + ttlMs });
    return result.response;
  };

  const buildManagedAssignment = async (
    request: ManagedAssignmentRequest,
  ): Promise<ApplyPlan | ApplyBlockedResponse> => {
    const state = await registryState(userDataPath);
    const project = activeRegistration(state, "project", request.projectId);
    const source = state.sources.find((record) => record.id === request.sourceId && record.archivedAt === undefined);
    if (source?.role === "storefront")
      return blocked("storefront-target", "Select the active workshop as the skill source.");
    const sourceGrant = grantFor(grants, { kind: "source", id: request.sourceId }, request.sourceGrantHandle);
    const projectGrant = grantFor(grants, { kind: "project", id: request.projectId }, request.projectGrantHandle);
    if (!project || !source || !isWorkshopSource(source) || !sourceGrant || !projectGrant)
      return blocked("entry-unavailable", "The selected source or project is unavailable.");
    if (!(await currentGrantRoot(sourceGrant)) || !(await currentGrantRoot(projectGrant)))
      return blocked("grant-invalid");
    if (
      !request.bindings.length ||
      request.bindings.some(
        (binding) =>
          binding.projectId !== request.projectId ||
          binding.sourceId !== request.sourceId ||
          binding.packageId !== request.packageId ||
          (request.artifactPath !== undefined && binding.artifactPath !== request.artifactPath),
      )
    )
      return blocked("binding-scope-invalid", "Selected bindings do not match the source and project.");
    const current = await bindingsStore.read();
    if (current.status !== "ready") return blocked("bindings-unavailable");
    for (const binding of request.bindings) {
      const existing = current.bindings.find(
        (candidate) =>
          candidate.projectId === binding.projectId &&
          candidate.harnessId === binding.harnessId &&
          candidate.sourceId === binding.sourceId &&
          candidate.packageId === binding.packageId &&
          candidate.artifactPath === binding.artifactPath &&
          candidate.kind === binding.kind,
      );
      if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
        return blocked("binding-changed", "The selected binding changed after preview.");
      if (!existing && !binding.bindingId.startsWith("preview-"))
        return blocked("binding-unavailable", "A selected binding is no longer registered.");
    }
    return buildApplyPlan({
      projectId: request.projectId,
      displayName: project.displayName,
      projectGrant,
      sourceGrant,
      bindings: request.bindings,
      settings: await settingsStore.read(),
      git,
    });
  };
  const previewManagedAssignment = async (
    request: ManagedAssignmentRequest,
  ): Promise<ManagedAssignmentPreview | ApplyBlockedResponse> => {
    if (new Set(request.bindings.map((binding) => binding.bindingId)).size !== request.bindings.length)
      return blocked("binding-duplicate", "Selected bindings must be unique.");
    const plan = await buildManagedAssignment(request);
    if ("status" in plan) return plan;
    if (plan.actions.some((item) => item.action.state === "blocked" || item.action.state === "conflict"))
      return blocked("plan-blocked", "One or more targets require a new explicit choice.");
    managedAssignmentPlans.set(plan.planId, { plan, request, expiresAt: now() + ttlMs });
    const current = await bindingsStore.read();
    if (current.status !== "ready") return blocked("bindings-unavailable");
    const managed = await createSkillRelationshipStore(join(userDataPath, "omni", "skill-relationships.json")).read();
    if (managed.status !== "ready")
      return blocked("relationships-unavailable", "Inspect the skill relationship store before assigning copies.");
    return buildManagedAssignmentPreview(plan, current.bindings, managed.state.uses);
  };
  const prepareManagedAssignment = async (planId: string, intentId: string): Promise<readonly string[]> => {
    const stored = managedAssignmentPlans.get(planId);
    if (!stored || expired(stored.expiresAt, now))
      throw new Error("The assignment preview expired; refresh it before applying.");
    const fresh = await buildManagedAssignment(stored.request);
    if ("status" in fresh || fresh.planId !== stored.plan.planId)
      throw new Error("The assignment changed after preview; refresh it before applying.");
    const files = new Set<string>();
    for (const item of fresh.actions) {
      if (item.action.state === "update") {
        for (const path of await listRegularFiles(item.projectGrant.root, item.action.relativePath)) files.add(path);
      }
    }
    const root = fresh.projectRoot;
    await backupFiles(root, join(userDataPath, "omni", "backups", "skill-intents", intentId, fresh.projectId), [
      ...files,
    ]);
    return [...files];
  };
  const runManagedAssignment = async (planId: string): Promise<ApplyRunResponse | ApplyBlockedResponse> => {
    const stored = managedAssignmentPlans.get(planId);
    if (!stored || expired(stored.expiresAt, now)) return blocked("plan-expired");
    const fresh = await buildManagedAssignment(stored.request);
    if ("status" in fresh) return fresh;
    if (fresh.planId !== stored.plan.planId) return blocked("plan-changed", "The project changed; preview it again.");
    if (fresh.actions.some((item) => item.action.state === "blocked" || item.action.state === "conflict"))
      return blocked("plan-blocked", "One or more targets require a new explicit choice.");
    managedAssignmentPlans.delete(planId);
    return executeApply(
      fresh,
      { planId, resolutions: [] },
      engineOptions(
        userDataPath,
        bindingsStore,
        operationStore,
        await settingsStore.read(),
        git,
        options.fileWriter,
        now,
      ),
    );
  };

  const runApply = async (raw: unknown): Promise<ApplyRunResponse | ApplyBlockedResponse> => {
    const request = parseApplyRunRequest(raw);
    const stored = applyPlans.get(request.planId);
    if (!stored || expired(stored.expiresAt, now)) {
      applyPlans.delete(request.planId);
      return blocked("plan-expired");
    }
    const fresh = await build(stored.request);
    if ("status" in fresh) return fresh;
    // The plan id already covers the unit hash and every target hash: re-planning is the change guard.
    if (fresh.planId !== stored.plan.planId) return blocked("plan-changed", "The project changed; preview it again.");
    const resolutions = new Map(request.resolutions.map((resolution) => [resolution.actionId, resolution.choice]));
    if (fresh.actions.some((item) => item.action.state === "blocked"))
      return blocked("plan-blocked", "One or more targets are managed or unsupported.");
    if (fresh.actions.some((item) => item.action.state === "conflict" && !resolutions.has(item.actionId)))
      return blocked("conflict-resolution", "Every conflict requires an explicit resolution.");
    applyPlans.delete(request.planId);
    return completeAssignment(
      await executeApply(
        fresh,
        request,
        engineOptions(
          userDataPath,
          bindingsStore,
          operationStore,
          await settingsStore.read(),
          git,
          options.fileWriter,
          now,
        ),
      ),
    );
  };

  const previewRemove = async (raw: unknown): Promise<RemovePreviewResponse | ApplyBlockedResponse> => {
    const request = parseRemovePreviewRequest(raw);
    const state = await registryState(userDataPath);
    const loaded = await bindingsStore.read();
    if (loaded.status !== "ready") return blocked("bindings-unavailable");
    const binding = loaded.bindings.find((candidate) => candidate.bindingId === request.bindingId);
    const project = binding && activeRegistration(state, "project", binding.projectId);
    const source =
      binding && state.sources.find((record) => record.id === binding.sourceId && record.archivedAt === undefined);
    const projectGrant = binding && grantFor(grants, { kind: "project", id: binding.projectId }, request.grantHandle);
    if (
      !binding ||
      !project ||
      !source ||
      !isWorkshopSource(source) ||
      !projectGrant ||
      !(await currentGrantRoot(projectGrant))
    )
      return blocked("entry-unavailable");
    const unit = await resolveUnitFromRoot(source.locator.canonicalPath, binding.packageId, binding.artifactPath);
    if (!unit) return blocked("marketplace-unavailable");
    const target = resolveTarget({ kind: unit.unit.kind, id: unit.unit.id, harnessId: binding.harnessId });
    if (target.status === "blocked") return blocked("target-blocked", target.reason);
    const observed = await observeTarget(projectGrant, unit.unit, binding.harnessId);
    const targetResult = await hashGrantedPath(projectGrant, target.relativePath);
    const targetMissing =
      targetResult.status !== "hashed" && (await isGrantedTargetAbsent(projectGrant, target.relativePath));
    if (targetResult.status !== "hashed" && !targetMissing)
      return blocked("target-unreadable", `Cannot safely inspect managed target: ${target.relativePath}`);
    let files: readonly RemoveFile[] = [];
    try {
      if (!targetMissing && targetResult.status === "hashed") {
        files = await removalFiles(projectGrant, target.relativePath, Boolean(observed.symlinkTarget), unit);
        // Ownership describes the last accepted project tree, independently of later source revisions.
        if (binding.ownedHash === targetResult.contentHash) files = files.map((file) => ({ ...file, modified: false }));
        else if (binding.ownedHash && files.every((file) => !file.modified))
          return blocked(
            "target-modified",
            `The managed target changed since its accepted revision: ${target.relativePath}`,
          );
      }
    } catch (error: unknown) {
      const relativePath = error instanceof RemoveTargetError ? error.relativePath : target.relativePath;
      return blocked("target-unreadable", `Cannot safely inspect managed target file: ${relativePath}`);
    }
    const actions = targetMissing
      ? []
      : await removalPreviewDiffs(
          projectGrant,
          await internalGrant(source.locator.canonicalPath),
          target.relativePath,
          files,
          unit,
        );
    const settings = await settingsStore.read();
    const planId = randomUUID();
    removePlans.set(planId, {
      planId,
      binding,
      projectRoot: projectGrant.root,
      projectGrant,
      targetPath: target.relativePath,
      unitId: unit.unit.id,
      harnessId: binding.harnessId,
      files,
      targetSnapshot: targetResult.status === "hashed" ? targetResult.contentHash : undefined,
      ...(targetMissing ? { targetMissing: true as const } : {}),
      expiresAt: now() + ttlMs,
      settings,
      projectName: project.displayName,
    });
    const mode = targetMissing ? "disabled" : await gitMode(git, settings, projectGrant.root);
    const head = mode === "commit" ? await git.headCommit(projectGrant.root) : undefined;
    return {
      status: "ready",
      planId,
      project: { displayName: project.displayName },
      unit: { id: unit.unit.id, harnessId: binding.harnessId },
      files: actions,
      ...(targetMissing
        ? {
            notes: [
              `The managed target is already gone: ${target.relativePath}`,
              "Forget this use: remove only the binding record; no project file is written or deleted. Undo restores the binding.",
            ],
          }
        : {}),
      git: { mode, ...(head ? { head } : {}) },
    };
  };

  const runRemove = async (raw: unknown): Promise<ApplyRunResponse | ApplyBlockedResponse> => {
    const request = parseRemoveRunRequest(raw);
    const stored = removePlans.get(request.planId);
    if (!stored || expired(stored.expiresAt, now)) return blocked("plan-expired");
    const modified = stored.files.find((file) => file.modified);
    if (modified)
      return blocked("target-modified", `The managed target file changed locally: ${modified.relativePath}`);
    for (const file of stored.files) {
      const current = await hashGrantedPath(stored.projectGrant, file.relativePath);
      if (current.status !== "hashed")
        return blocked("target-unreadable", `Cannot safely inspect managed target file: ${file.relativePath}`);
      if (current.contentHash !== file.contentHash)
        return blocked("target-modified", `The managed target file changed after preview: ${file.relativePath}`);
    }
    if (stored.targetMissing) {
      if (!(await isGrantedTargetAbsent(stored.projectGrant, stored.targetPath)))
        return blocked("plan-changed", "The absent target changed or cannot be inspected safely; preview it again.");
      const bindings = await bindingsStore.read();
      const current =
        bindings.status === "ready"
          ? bindings.bindings.find((binding) => binding.bindingId === stored.binding.bindingId)
          : undefined;
      if (!sameBindingRecord(current, stored.binding))
        return blocked("plan-changed", "The binding changed; preview it again.");
    }
    const currentTarget = await hashGrantedPath(stored.projectGrant, stored.targetPath);
    const currentSnapshot = currentTarget.status === "hashed" ? currentTarget.contentHash : undefined;
    if (currentSnapshot !== stored.targetSnapshot)
      return blocked("plan-changed", "The project changed; preview it again.");
    removePlans.delete(request.planId);
    const operationId = request.operationId ?? randomUUID();
    const paths = stored.files.map((file) => file.relativePath);
    const backupRoot = join(userDataPath, "omni/backups", operationId, stored.binding.projectId);
    let bindingRemoved = false;
    try {
      await backupFiles(stored.projectRoot, backupRoot, paths);
      const stop = await removeStopPath(stored.targetPath);
      for (const path of paths) await removeFileOrEmptyDirectories(stored.projectRoot, path, stop);
      const removed = stored.targetMissing
        ? await bindingsStore.updateExact([{ bindingId: stored.binding.bindingId, expected: stored.binding }])
        : await bindingsStore.remove(stored.binding.bindingId);
      if (removed.status !== "ready") throw new Error("Binding could not be removed safely.");
      bindingRemoved = true;
      const mode = stored.files.length === 0 ? "disabled" : await gitMode(git, stored.settings, stored.projectRoot);
      const headBefore = mode === "commit" ? await git.headCommit(stored.projectRoot) : undefined;
      let commit: string | undefined;
      if (mode === "commit" && paths.length && (await git.hasChanges(stored.projectRoot, paths))) {
        const result = await git.commitAll(
          stored.projectRoot,
          assignmentCommitMessage("Remove", [stored.unitId], [harnessName(stored.harnessId)]),
          paths,
        );
        if (result.status !== "committed") throw new Error(result.diagnostic);
        commit = result.commit;
      }
      const receipt: OperationReceipt = {
        operationId,
        kind: "remove-binding",
        status: "applied",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.projectName,
        actions: paths.map((relativePath) => ({
          kind: "delete-file" as const,
          relativePath,
          status: "applied" as const,
        })),
        git: {
          mode,
          ...(commit ? { commit } : {}),
          ...(headBefore ? { headBefore } : {}),
          ...(commit ? { headAfter: commit } : {}),
        },
        registered: null,
        project: { id: stored.binding.projectId },
        bindings: [{ bindingId: stored.binding.bindingId, binding: stored.binding, before: stored.binding }],
        files: stored.files,
        units: [stored.unitId],
      };
      const saved = await operationStore.append(receipt);
      if (saved.status !== "ready") throw new Error("Removal receipt could not be persisted safely.");
      return { status: "applied", receipt };
    } catch (error: unknown) {
      for (const file of stored.files)
        await restoreBackup(stored.projectRoot, backupRoot, file.relativePath).catch(() => false);
      if (bindingRemoved) await bindingsStore.save([stored.binding]).catch(() => undefined);
      return {
        status: "failed",
        receipt: {
          operationId,
          kind: "remove-binding",
          status: "failed",
          appliedAt: new Date(now()).toISOString(),
          displayTarget: stored.projectName,
          actions: [],
          git: { mode: "unavailable" },
          registered: null,
          project: { id: stored.binding.projectId },
          diagnostic: safeError(error),
          units: [stored.unitId],
        },
      };
    }
  };

  const previewRestore = async (raw: unknown): Promise<RestorePreviewResponse | ApplyBlockedResponse> => {
    const request = parseRestorePreviewRequest(raw);
    const stored = await operationStore.read();
    if (stored.status !== "ready") return blocked("operations-unavailable");
    const receipt = stored.receipts.find(
      (candidate) =>
        (candidate.kind === "apply-plan" || candidate.kind === "remove-binding") &&
        candidate.operationId === request.operationId &&
        candidate.status === "applied" &&
        !candidate.restored,
    );
    if (!receipt || !receipt.project || !receipt.files) return blocked("restore-unavailable");
    const state = await registryState(userDataPath);
    const project = activeRegistration(state, "project", receipt.project.id);
    if (!project) return blocked("entry-unavailable");
    const grant = await internalGrant(project.locator.canonicalPath);
    for (const file of receipt.files) {
      const current = await hashGrantedPath(grant, file.relativePath);
      if (
        receipt.kind === "remove-binding"
          ? current.status === "hashed"
          : current.status !== "hashed" || current.contentHash !== file.contentHash
      )
        return blocked(receipt.kind === "remove-binding" ? "restore-drift" : "restore-drift");
    }
    const currentBindings = await bindingsStore.read();
    if (currentBindings.status !== "ready") return blocked("bindings-unavailable");
    if (receipt.kind === "remove-binding") {
      if (
        (receipt.bindings ?? []).some((effect) =>
          currentBindings.bindings.some((binding) => binding.bindingId === effect.bindingId),
        )
      )
        return blocked("restore-drift", "The removed binding changed after the receipt was created.");
    } else {
      for (const effect of receipt.bindings ?? []) {
        const current = currentBindings.bindings.find((binding) => binding.bindingId === effect.bindingId);
        if (effect.after && !sameBindingRecord(current, effect.after))
          return blocked("restore-drift", "An affected binding changed after the receipt was created.");
      }
    }
    const planId = randomUUID();
    restorePlans.set(planId, {
      planId,
      receipt,
      projectRoot: grant.root,
      projectName: project.displayName,
      settings: await settingsStore.read(),
      expiresAt: now() + ttlMs,
    });
    return {
      status: "ready",
      planId,
      project: { id: receipt.project.id },
      files: receipt.files.map((file) => ({
        relativePath: file.relativePath,
        action: receipt.kind === "remove-binding" || file.previousHash ? "restore" : "delete",
      })),
    };
  };

  const runRestoreRequest = async (request: RestoreRunRequest): Promise<ApplyRunResponse | ApplyBlockedResponse> => {
    const stored = restorePlans.get(request.planId);
    if (!stored || expired(stored.expiresAt, now)) return blocked("plan-expired");
    const grant = await internalGrant(stored.projectRoot);
    for (const file of stored.receipt.files ?? []) {
      const current = await hashGrantedPath(grant, file.relativePath);
      if (
        stored.receipt.kind === "remove-binding"
          ? current.status === "hashed"
          : current.status !== "hashed" || current.contentHash !== file.contentHash
      )
        return blocked("restore-drift");
    }
    const currentBindings = await bindingsStore.read();
    if (currentBindings.status !== "ready") return blocked("bindings-unavailable");
    if (stored.receipt.kind === "remove-binding") {
      if (
        (stored.receipt.bindings ?? []).some((effect) =>
          currentBindings.bindings.some((binding) => binding.bindingId === effect.bindingId),
        )
      )
        return blocked("restore-drift", "The removed binding changed after the receipt was created.");
    } else {
      for (const effect of stored.receipt.bindings ?? []) {
        const current = currentBindings.bindings.find((binding) => binding.bindingId === effect.bindingId);
        if (effect.after && !sameBindingRecord(current, effect.after))
          return blocked("restore-drift", "An affected binding changed after the receipt was created.");
      }
    }
    restorePlans.delete(request.planId);
    const backupRoot = join(userDataPath, "omni/backups", stored.receipt.operationId, stored.receipt.project!.id);
    try {
      for (const file of stored.receipt.files ?? []) {
        if (stored.receipt.kind === "remove-binding" || file.previousHash)
          await restoreBackup(stored.projectRoot, backupRoot, file.relativePath);
        else await removeFileOrEmptyDirectories(stored.projectRoot, file.relativePath, ".");
      }
      const mode =
        stored.receipt.files?.length === 0 ? "disabled" : await gitMode(git, stored.settings, stored.projectRoot);
      const paths = (stored.receipt.files ?? []).map((file) => file.relativePath);
      const headBefore = mode === "commit" ? await git.headCommit(stored.projectRoot) : undefined;
      let commit: string | undefined;
      if (mode === "commit" && paths.length && (await git.hasChanges(stored.projectRoot, paths))) {
        const units = stored.receipt.units ?? [stored.receipt.displayTarget];
        const result = await git.commitAll(
          stored.projectRoot,
          assignmentCommitMessage("Restore", units, harnessesFromPaths(paths)),
          paths,
        );
        if (result.status !== "committed") throw new Error(result.diagnostic);
        commit = result.commit;
      }
      if (stored.receipt.kind === "remove-binding") {
        const binding = stored.receipt.bindings?.find(
          (item) => (item.before ?? item.binding)?.bindingId === item.bindingId,
        );
        const savedBinding = binding?.before ?? binding?.binding;
        if (!binding || !savedBinding) throw new Error("Removed binding backup is unavailable.");
        const saved = await bindingsStore.updateExact([{ bindingId: savedBinding.bindingId, next: savedBinding }]);
        if (saved.status !== "ready") throw new Error("Binding could not be restored safely.");
      } else {
        const receiptBindings = stored.receipt.bindings ?? [];
        const hasExactEffects = receiptBindings.some((item) => item.before !== undefined || item.after !== undefined);
        const saved = hasExactEffects
          ? await bindingsStore.updateExact(
              receiptBindings.map((item) => ({
                bindingId: item.bindingId,
                ...(item.after ? { expected: item.after } : {}),
                ...(item.before ? { next: item.before } : {}),
              })),
            )
          : await (async () => {
              const loaded = await bindingsStore.read();
              if (loaded.status !== "ready") return loaded;
              const previous = new Map(receiptBindings.map((item) => [item.bindingId, item.previousOwnedHash]));
              const next = loaded.bindings.map((binding) =>
                previous.has(binding.bindingId)
                  ? {
                      ...binding,
                      ...(previous.get(binding.bindingId)
                        ? { ownedHash: previous.get(binding.bindingId) }
                        : { ownedHash: undefined }),
                    }
                  : binding,
              );
              return bindingsStore.save(next);
            })();
        if (saved.status !== "ready") throw new Error("Bindings could not be restored safely.");
      }
      const receipt: OperationReceipt = {
        operationId: randomUUID(),
        kind: "restore-apply",
        status: "applied",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.projectName,
        actions: (stored.receipt.files ?? []).map((file) => ({
          kind:
            file.previousHash || stored.receipt.kind === "remove-binding"
              ? ("write-file" as const)
              : ("delete-file" as const),
          relativePath: file.relativePath,
          status: "applied" as const,
        })),
        git: {
          mode,
          ...(commit ? { commit } : {}),
          ...(headBefore ? { headBefore } : {}),
          ...(commit ? { headAfter: commit } : {}),
        },
        registered: null,
        project: stored.receipt.project,
        restores: stored.receipt.operationId,
        files: stored.receipt.files,
        units: stored.receipt.units,
      };
      const appended = await operationStore.append(receipt);
      if (appended.status !== "ready") throw new Error("Restore receipt could not be persisted safely.");
      const marked = await operationStore.markRestored(stored.receipt.operationId);
      if (marked.status !== "ready") throw new Error("Original receipt could not be marked restored safely.");
      return { status: "applied", receipt };
    } catch (error: unknown) {
      return {
        status: "failed",
        receipt: {
          operationId: randomUUID(),
          kind: "restore-apply",
          status: "failed",
          appliedAt: new Date(now()).toISOString(),
          displayTarget: stored.projectName,
          actions: [],
          git: { mode: "unavailable" },
          registered: null,
          project: stored.receipt.project,
          diagnostic: safeError(error),
        },
      };
    }
  };

  ipcMain.handle(APPLY_IPC_CHANNELS.preview, guard(previewApply));
  ipcMain.handle(APPLY_IPC_CHANNELS.run, guard(runApply));
  ipcMain.handle(APPLY_IPC_CHANNELS.removePreview, guard(previewRemove));
  ipcMain.handle(APPLY_IPC_CHANNELS.removeRun, guard(runRemove));
  ipcMain.handle(APPLY_IPC_CHANNELS.restorePreview, guard(previewRestore));
  const runRestore = async (raw: unknown): Promise<ApplyRunResponse | ApplyBlockedResponse> =>
    runRestoreRequest(parseRestoreRunRequest(raw));
  ipcMain.handle(APPLY_IPC_CHANNELS.restoreRun, guard(runRestore));
  return {
    onAssignmentCompleted(handler): void {
      assignmentCompleted = handler;
    },
    previewRemove,
    runRemove,
    previewRestore,
    runRestore,
    previewManagedAssignment,
    prepareManagedAssignment,
    runManagedAssignment,
  };
}
