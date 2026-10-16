import { createHash } from "node:crypto";

import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import { fingerprintSkillEffects } from "../../domain/skill-management-intent";
import { planUnboundSkillResolution } from "../../domain/skill-reconciliation/unbound-resolution";
import { compareSkillCopyFileBytes } from "../../domain/skill-reconciliation/comparison";
import type { SkillUnboundResolutionRequest } from "../../shared/skill-unbound-resolution-request";
import type { SkillEffectStep, SkillIntent, SkillIssue } from "../../shared/skill-management-ipc";
import type { SkillAdoptionRequest } from "../../shared/skill-reconciliation-request";
import type { SkillFileSummary } from "../../shared/skill-management-ipc";
import type { OperationAction, OperationActionReceipt, OperationReceipt } from "../../shared/operations-ipc";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { FileWriter } from "../operation-files";
import { readSkillUnboundResolutionSnapshot, type SkillUnboundResolutionSnapshot } from "./unbound-reader";
import { prepareUnboundPayload, readPreparedUnboundPayload, type PreparedUnboundPayload } from "./unbound-payload";
import { applyUnboundResolution } from "./unbound-application";
import { planUnboundRecovery, type UnboundRecoveryDependencies, type UnboundRecoveryPlan } from "./unbound-recovery";
import { applyUnboundRecovery } from "./unbound-recovery-application";
import type { SkillOperationJournal } from "../../application/skill-management-journal";
import { resolveSkillUnboundResolutionReceiptRecord } from "./unbound-receipt";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import { resolutionIssue } from "./resolution-receipts";

type UnboundIntent = Extract<SkillIntent, { kind: "reconcile" }> & Readonly<{ request: SkillUnboundResolutionRequest }>;
type ReadySnapshot = Extract<SkillUnboundResolutionSnapshot, { status: "ready" }>;
type ReadyPlan = Extract<ReturnType<typeof planUnboundSkillResolution>, { status: "ready" }>;
type SavedPlan = Readonly<{
  intentId: string;
  request: SkillUnboundResolutionRequest;
  snapshot: ReadySnapshot;
  step: SkillEffectStep;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function stableId(seed: string): string {
  const value = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16]!, 16) & 3) | 8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function planFor(
  snapshot: ReadySnapshot,
  intentId: string,
  createdAt: string,
):
  | ReadyPlan
  | Extract<ReturnType<typeof planUnboundSkillResolution>, { status: "adopt-exact" | "blocked" | "needs-input" }> {
  return planUnboundSkillResolution({
    request: snapshot.request,
    record: snapshot.record,
    storeRevision: snapshot.relationships.revision,
    source: {
      ref: snapshot.request.source,
      rootIdentity: snapshot.rootIdentities.source,
      revision: snapshot.sourceTree.revision,
    },
    local: {
      location: snapshot.request.locations[0],
      rootIdentity: snapshot.rootIdentities.project,
      revision: snapshot.localTree.revision,
    },
    uses: snapshot.relationships.uses,
    bindings: snapshot.bindings,
    envelope: { source: snapshot.sourceEnvelope, local: snapshot.localEnvelope },
    allocateId: (kind) => stableId(`${intentId}\nunbound-link\n${kind}`),
    now: createdAt,
  });
}

function filePresentation(snapshot: ReadySnapshot, files: readonly SkillFileSummary[]): SkillFileSummary[] {
  const folderPath = snapshot.request.locations[0]!.folderPath;
  return files.map((file) => {
    const path = file.relativePath.slice(folderPath.length + 1);
    const presentation = compareSkillCopyFileBytes(
      { path, change: file.change },
      snapshot.localTree.files.get(path),
      snapshot.sourceTree.files.get(path),
    );
    return {
      ...file,
      ...(presentation.diff ? { diff: presentation.diff } : {}),
      ...(presentation.summary ? { summary: presentation.summary } : {}),
    };
  });
}

function directoryActions(snapshot: ReadySnapshot): OperationAction[] {
  const location = snapshot.request.locations[0]!;
  const localDirectories = new Set(
    snapshot.localEnvelope.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  );
  return snapshot.sourceEnvelope
    .filter(
      (entry) =>
        entry.kind === "directory" &&
        entry.path !== "." &&
        !entry.path.split("/").includes(".git") &&
        !localDirectories.has(entry.path),
    )
    .sort(
      (left, right) =>
        left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path),
    )
    .map((entry) => ({ kind: "create-directory", relativePath: `${location.folderPath}/${entry.path}` }));
}

function buildStep(snapshot: ReadySnapshot, plan: ReadyPlan): SkillEffectStep {
  const files = filePresentation(snapshot, plan.files);
  const fileActions: OperationAction[] = files.map((file) => ({
    kind: file.change === "delete" ? "delete-file" : "write-file",
    relativePath: file.relativePath,
    ...(file.beforeHash ? { beforeHash: file.beforeHash } : {}),
    ...(file.afterHash ? { afterHash: file.afterHash } : {}),
    ...(file.byteLength === undefined ? {} : { byteLength: file.byteLength }),
    ...(file.diff ? { diff: file.diff } : {}),
  }));
  const actions = [...directoryActions(snapshot), ...fileActions];
  const operationPlan = {
    planId: plan.stepId,
    kind: "link-skill" as const,
    displayTarget: snapshot.request.locations[0]!.folderPath,
    actions,
    git: { mode: "unavailable" as const, warnings: [] },
  };
  return {
    stepId: plan.stepId,
    scope: plan.scope,
    plan: operationPlan,
    bindingEffects: plan.bindingEffects,
    files,
    metadataEffects: plan.metadataEffects,
    baseReferences: plan.baseReferences,
    unboundResolutionEvidence: plan.evidence,
    unboundResolutionEnvelope: { source: snapshot.sourceEnvelope, local: snapshot.localEnvelope },
  };
}

function draft(snapshot: ReadySnapshot, intentId: string, createdAt: string): SkillEffectDraft {
  const plan = planFor(snapshot, intentId, createdAt);
  if (plan.status !== "ready")
    throw new Error("A ready unbound resolution snapshot no longer produces a replacement plan.");
  const step = buildStep(snapshot, plan);
  const fingerprint = {
    ...plan.fingerprint,
    files: step.files,
    actions: step.plan.actions.map((action) => ({
      rootId: snapshot.request.locations[0]!.projectId,
      kind: action.kind,
      relativePath: action.relativePath,
      ...(action.beforeHash === undefined ? {} : { beforeHash: action.beforeHash }),
      ...(action.afterHash === undefined ? {} : { afterHash: action.afterHash }),
    })),
    unboundResolutionEnvelope: step.unboundResolutionEnvelope,
  };
  return {
    status: "ready",
    planId: step.stepId,
    scope: step.scope,
    steps: [step],
    fingerprint,
    backupReferences: [
      { rootId: snapshot.request.locations[0]!.projectId, path: `skill-unbound-resolutions/${intentId}` },
    ],
  };
}

function issue(code: string, message: string, recoveryAction: SkillIssue["recoveryAction"] = "reconnect"): SkillIssue {
  return resolutionIssue(code, message, recoveryAction);
}

function blocked(code: string, message: string, status: "blocked" | "needs-input" = "blocked"): SkillEffectBuild {
  return {
    status,
    reason: message,
    details: [issue(code, message, status === "needs-input" ? "choose-targets" : "reconnect")],
  };
}

function planBackupMatches(payload: PreparedUnboundPayload, snapshot: ReadySnapshot): boolean {
  const match = (saved: ReadonlyMap<string, Uint8Array>, current: ReadonlyMap<string, Uint8Array>): boolean =>
    saved.size === current.size &&
    [...saved].every(([path, bytes]) => {
      const candidate = current.get(path);
      return (
        candidate !== undefined &&
        bytes.byteLength === candidate.byteLength &&
        createHash("sha256").update(bytes).digest("hex") === createHash("sha256").update(candidate).digest("hex")
      );
    });
  return (
    match(payload.sourceFiles, snapshot.sourceTree.files) &&
    match(payload.beforeFiles, snapshot.localTree.files) &&
    canonical(payload.index.sourceEnvelope) === canonical(snapshot.sourceEnvelope) &&
    canonical(payload.index.beforeEnvelope) === canonical(snapshot.localEnvelope)
  );
}

function actionReceipt(
  step: SkillEffectStep,
  statuses: ReadonlyMap<string, OperationActionReceipt["status"]>,
): OperationActionReceipt[] {
  return step.plan.actions.map((action) => ({
    ...action,
    status: statuses.get(`${action.kind}\n${action.relativePath}`) ?? "failed",
  }));
}

export function createSkillUnboundResolutionAdapter(
  args: Readonly<{
    userDataPath: string;
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    adoption?: ReturnType<typeof import("./adoption").createSkillAdoptionAdapter>;
    filesystem?: SkillObservationFilesystem;
    fileWriter?: FileWriter;
    journal: SkillOperationJournal;
    now?: () => number;
  }>,
): Readonly<{
  preview(intent: UnboundIntent, intentId: string, createdAt: number): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  previewRecovery(
    record: SkillOperationJournalRecord,
    restoreIntentId: string,
    original?: OperationReceipt,
  ): Promise<SkillEffectBuild>;
  isRecoveryEffect(effect: SkillEffectDraft): boolean;
  prepareRecovery(restoreIntentId: string, effect: SkillEffectDraft): Promise<void>;
  applyRecovery(
    restoreIntentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const now = args.now ?? Date.now;
  const plans = new Map<string, SavedPlan>();
  const recoveryPlans = new Map<string, UnboundRecoveryPlan>();
  const read = (request: SkillUnboundResolutionRequest) =>
    readSkillUnboundResolutionSnapshot(request, {
      registry: args.registry,
      relationships: args.relationships,
      bindings: args.bindings,
      ...(args.filesystem ? { filesystem: args.filesystem } : {}),
      now,
    });
  const preview = async (intent: UnboundIntent, intentId: string, createdAt: number): Promise<SkillEffectBuild> => {
    const snapshot = await read(intent.request);
    if (snapshot.status !== "ready") return blocked(snapshot.code, snapshot.message);
    const planned = planFor(snapshot, intentId, new Date(createdAt).toISOString());
    if (planned.status === "adopt-exact") {
      if (!args.adoption)
        return blocked("adoption-adapter-unavailable", "Exact-copy adoption is unavailable in this session.");
      return args.adoption.preview({ kind: "reconcile", request: planned.request }, intentId);
    }
    if (planned.status !== "ready") return blocked(planned.code, planned.reason, planned.status);
    const built = draft(snapshot, intentId, new Date(createdAt).toISOString());
    const step = built.steps[0]!;
    plans.set(step.stepId, { intentId, request: intent.request, snapshot, step });
    return built;
  };
  const savedPlan = (effect: SkillEffectDraft): SavedPlan => {
    const saved = plans.get(effect.planId);
    if (
      !saved ||
      effect.steps.length !== 1 ||
      effect.steps[0]?.stepId !== saved.step.stepId ||
      canonical(effect.steps[0]) !== canonical(saved.step)
    )
      throw new Error("The reviewed unbound resolution preview expired.");
    return saved;
  };
  const freshPlan = async (saved: SavedPlan): Promise<ReadySnapshot> => {
    const fresh = await read(saved.request);
    if (fresh.status !== "ready") throw new Error(fresh.message);
    const rebuilt = draft(fresh, saved.intentId, saved.step.bindingEffects[0]!.after!.createdAt);
    if (canonical(rebuilt.steps[0]) !== canonical(saved.step))
      throw new Error("The selected source, local tree, root, relationship, or target claims changed after review.");
    return fresh;
  };
  const prepare = async (intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const saved = savedPlan(effect);
    if (saved.intentId !== intentId) throw new Error("The unbound resolution parent changed before preparation.");
    const snapshot = await freshPlan(saved);
    const payload = await prepareUnboundPayload({
      userDataPath: args.userDataPath,
      intentId,
      sourceFiles: snapshot.sourceTree.files,
      beforeFiles: snapshot.localTree.files,
      sourceEnvelope: snapshot.sourceEnvelope,
      beforeEnvelope: snapshot.localEnvelope,
    });
    if (!planBackupMatches(payload, snapshot))
      throw new Error("The durable source payload or local backup failed verification.");
    const base = saved.step.baseReferences?.[0];
    if (!base) throw new Error("The selected-source base reference is missing.");
    const existing = await args.bases.read(base.baseRevisionId);
    if (existing.status === "ready") {
      if (canonical(existing.revision) !== canonical(base.revision))
        throw new Error("The immutable base id contains different bytes.");
    } else {
      await args.bases.publish(base.baseRevisionId, snapshot.sourceTree.revision, snapshot.sourceTree.files);
    }
    const verified = await args.bases.read(base.baseRevisionId);
    if (verified.status !== "ready" || canonical(verified.revision) !== canonical(base.revision))
      throw new Error("The selected-source immutable base failed verification.");
    await freshPlan(saved);
  };
  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const saved = savedPlan(effect);
    const snapshot = await freshPlan(saved);
    const payload = await readPreparedUnboundPayload(args.userDataPath, intentId);
    if (!payload || !planBackupMatches(payload, snapshot))
      throw new Error("Verified before-tree backup and frozen source payload are unavailable.");
    return applyUnboundResolution({
      intentId,
      snapshot,
      step: saved.step,
      payload,
      progress,
      relationships: args.relationships,
      bindings: args.bindings,
      bases: args.bases,
      operationStore: args.operationStore,
      filesystem: args.filesystem,
      now,
      read,
    });
  };
  const recoveryDependencies: UnboundRecoveryDependencies = {
    userDataPath: args.userDataPath,
    registry: args.registry,
    relationships: args.relationships,
    bindings: args.bindings,
    bases: args.bases,
    operationStore: args.operationStore,
    journal: args.journal,
    filesystem: args.filesystem ?? strictSkillObservationFilesystem,
    now,
  };
  const previewRecovery = async (
    record: SkillOperationJournalRecord,
    restoreIntentId: string,
    original?: OperationReceipt,
  ): Promise<SkillEffectBuild> => {
    try {
      if (original && resolveSkillUnboundResolutionReceiptRecord(original, { status: "ready", record }) !== record)
        throw new Error("The selected child receipt does not match its saved D3 parent effect.");
      const plan = await planUnboundRecovery(recoveryDependencies, record, restoreIntentId);
      const step = plan.effect.steps[0]!;
      recoveryPlans.set(step.stepId, plan);
      return plan.effect;
    } catch (error: unknown) {
      return blocked(
        "unbound-restore-blocked",
        error instanceof Error ? error.message : "Unbound linkage restore could not be inspected safely.",
      );
    }
  };
  const isRecoveryEffect = (effect: SkillEffectDraft): boolean =>
    effect.steps.length === 1 && effect.steps[0]?.unboundResolutionRestoreOrigin !== undefined;
  const recoveryPlan = async (restoreIntentId: string, effect: SkillEffectDraft): Promise<UnboundRecoveryPlan> => {
    if (!isRecoveryEffect(effect)) throw new Error("The saved effect is not an unbound link inverse.");
    const saved = recoveryPlans.get(effect.planId);
    if (
      saved &&
      saved.original.intentId === effect.steps[0]!.unboundResolutionRestoreOrigin!.intentId &&
      canonical(saved.effect) === canonical(effect)
    )
      return saved;
    const origin = effect.steps[0]!.unboundResolutionRestoreOrigin!;
    const original = await args.journal.read(origin.intentId);
    if (original.status !== "ready") throw new Error("The original D3 journal is unavailable for inverse recovery.");
    const rebuilt = await planUnboundRecovery(recoveryDependencies, original.record, restoreIntentId);
    if (rebuilt.sourceStep.stepId !== origin.stepId || canonical(rebuilt.effect) !== canonical(effect))
      throw new Error("The saved inverse no longer matches exact project files, ownership, or management state.");
    recoveryPlans.set(effect.planId, rebuilt);
    return rebuilt;
  };
  const prepareRecovery = async (restoreIntentId: string, effect: SkillEffectDraft): Promise<void> => {
    await recoveryPlan(restoreIntentId, effect);
  };
  const applyRecovery = async (
    restoreIntentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const plan = await recoveryPlan(restoreIntentId, effect);
    return applyUnboundRecovery({ plan, restoreIntentId, progress, dependencies: recoveryDependencies });
  };
  return {
    preview,
    prepare,
    apply,
    previewRecovery,
    isRecoveryEffect,
    prepareRecovery,
    applyRecovery,
    has: (planId) => plans.has(planId),
  };
}
