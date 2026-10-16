import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournalRecord, SkillOperationJournal } from "../../application/skill-management-journal";
import type { SkillEffectStep, SkillResult } from "../../shared/skill-management-ipc";
import type { OperationActionReceipt, OperationReceipt } from "../../shared/operations-ipc";
import type { SkillRelationshipStore, SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { RegistryIpcServices } from "../registry-ipc";
import { readRegularFile, removeFileOrEmptyDirectories, writeAtomically, type FileWriter } from "../operation-files";
import { readSkillResolutionSnapshot, type SkillResolutionSnapshot } from "./resolution-reader";
import { recordParentRestored } from "./restore-parent";
import { assertResolutionWritePath } from "./resolution-write-guard";
import {
  buildResolutionRestoreEffect as buildEffect,
  canonical,
  hash,
  locationKey,
  metadataAtExpectedResolutionStates as metadataAtExpectedStates,
  originalResolutionStep as originalStep,
  resolutionRequestFor,
  resolutionRestoreSummary as restoreSummary,
  resolutionRestoreTargets as restoreTargets,
  reverseResolutionBindingEffects as reverseBindingEffects,
  reverseResolutionUseEffects as reverseUseEffects,
  stateAtExpectedResolutionBytes as stateAtExpectedBytes,
  stateAtCompletedResolutionEffect,
  verifyResolutionBackup as verifyBackup,
} from "./resolution-recovery-plan";

type Snapshot = Extract<SkillResolutionSnapshot, { status: "ready" }>;
type RecoveryPlan = Readonly<{
  original: SkillOperationJournalRecord;
  originalStep: SkillEffectStep;
  effect: SkillEffectDraft;
  reviewed: Snapshot;
}>;

export function createSkillResolutionRecoveryAdapter(
  args: Readonly<{
    userDataPath: string;
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    journal: SkillOperationJournal;
    filesystem?: SkillObservationFilesystem;
    fileWriter?: FileWriter;
    now?: () => number;
  }>,
): Readonly<{
  preview(record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const now = args.now ?? Date.now;
  const plans = new Map<string, RecoveryPlan>();
  const read = (step: SkillEffectStep) =>
    readSkillResolutionSnapshot(
      resolutionRequestFor(step),
      {
        registry: args.registry,
        relationships: args.relationships,
        bindings: args.bindings,
        bases: args.bases,
        ...(args.filesystem ? { filesystem: args.filesystem } : {}),
        now,
      },
      "skip",
    );
  const preview = async (record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild> => {
    try {
      const source = originalStep(record);
      if (
        record.status === "terminal" &&
        record.result?.status !== "applied" &&
        record.result?.status !== "recovery-required"
      )
        throw new Error("This operation has no applied canonical effect to restore.");
      const snapshot = await read(source);
      if (snapshot.status !== "ready") throw new Error(snapshot.message);
      if (
        snapshot.rootIdentities.project !== source.resolutionEvidence!.local.rootIdentity ||
        !stateAtExpectedBytes(snapshot, source) ||
        !metadataAtExpectedStates(snapshot, source) ||
        (record.status === "terminal" &&
          record.result?.status === "applied" &&
          !stateAtCompletedResolutionEffect(snapshot, source))
      )
        throw new Error("The selected tree or metadata contains changes outside the saved canonical transition.");
      const backup = await verifyBackup({ userDataPath: args.userDataPath, record, step: source });
      let canonicalBytes: ReadonlyMap<string, Uint8Array> = new Map();
      for (const base of source.baseReferences ?? []) {
        const stored = await args.bases.read(base.baseRevisionId);
        if (stored.status !== "ready" || canonical(stored.revision) !== canonical(base.revision))
          throw new Error("A referenced immutable before or after base is missing or corrupt.");
        if (canonical(base.revision) === canonical(source.resolutionEvidence!.sourceTree!.revision))
          canonicalBytes = stored.files;
      }
      if (source.files.length && canonicalBytes.size === 0)
        throw new Error("The verified canonical base bytes are unavailable for a reverse diff.");
      const effect = buildEffect(source, intentId, canonicalBytes, backup.bytes);
      plans.set(effect.planId, { original: record, originalStep: source, effect, reviewed: snapshot });
      return effect;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Managed resolution recovery could not be inspected safely.";
      return {
        status: "blocked",
        reason: message,
        details: [{ code: "resolution-recovery-blocked", message, recoveryAction: "inspect-recovery" }],
      };
    }
  };
  const getPlan = (effect: SkillEffectDraft): RecoveryPlan => {
    const saved = plans.get(effect.planId);
    if (!saved || saved.effect.steps[0]?.stepId !== effect.steps[0]?.stepId)
      throw new Error("The managed resolution recovery preview expired; refresh it.");
    return saved;
  };
  const validate = async (saved: RecoveryPlan): Promise<Snapshot> => {
    const snapshot = await read(saved.originalStep);
    if (
      snapshot.status !== "ready" ||
      snapshot.rootIdentities.project !== saved.originalStep.resolutionEvidence!.local.rootIdentity ||
      !stateAtExpectedBytes(snapshot, saved.originalStep) ||
      !metadataAtExpectedStates(snapshot, saved.originalStep) ||
      (saved.originalStep.files.length > 0 &&
        canonical(snapshot.localTree.revision) !== canonical(saved.reviewed.localTree.revision)) ||
      canonical(snapshot.use) !== canonical(saved.reviewed.use) ||
      canonical(snapshot.binding) !== canonical(saved.reviewed.binding)
    )
      throw new Error("The selected tree or metadata changed after recovery review.");
    await verifyBackup({ userDataPath: args.userDataPath, record: saved.original, step: saved.originalStep });
    for (const base of saved.originalStep.baseReferences ?? []) {
      const stored = await args.bases.read(base.baseRevisionId);
      if (stored.status !== "ready" || canonical(stored.revision) !== canonical(base.revision))
        throw new Error("A referenced immutable base changed after recovery review.");
    }
    return snapshot;
  };
  const prepare = async (_intentId: string, effect: SkillEffectDraft): Promise<void> => {
    await validate(getPlan(effect));
  };
  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const saved = getPlan(effect);
    const snapshot = await validate(saved);
    const source = saved.originalStep;
    const evidence = source.resolutionEvidence!;
    const step = effect.steps[0]!;
    const backup = await verifyBackup({ userDataPath: args.userDataPath, record: saved.original, step: source });
    const actions: OperationActionReceipt[] = [];
    await progress({ stepId: step.stepId, status: "applying" });
    try {
      for (const file of source.files) {
        const relativePath = file.relativePath;
        const inner = relativePath.slice(evidence.local.location.folderPath.length + 1);
        await assertResolutionWritePath(snapshot.projectGrant, relativePath);
        const current = await readRegularFile(snapshot.projectGrant.root, relativePath);
        const inverseKind = file.change === "add" ? ("delete-file" as const) : ("write-file" as const);
        if (hash(current) === file.beforeHash) {
          actions.push({
            kind: inverseKind,
            relativePath,
            ...(file.afterHash ? { beforeHash: file.afterHash } : {}),
            ...(file.beforeHash ? { afterHash: file.beforeHash } : {}),
            status: "rolled-back",
          });
          continue;
        }
        if (hash(current) !== file.afterHash)
          throw new Error(`The selected file changed outside the reviewed transition: ${relativePath}`);
        await assertResolutionWritePath(snapshot.projectGrant, relativePath);
        if (file.change === "add") {
          await removeFileOrEmptyDirectories(
            snapshot.projectGrant.root,
            relativePath,
            evidence.local.location.folderPath,
          );
        } else {
          const original = backup.bytes.get(inner);
          if (!original) throw new Error(`The saved before-resolution bytes are unavailable: ${inner}`);
          await writeAtomically(snapshot.projectGrant.root, relativePath, original, args.fileWriter);
        }
        const restored = await readRegularFile(snapshot.projectGrant.root, relativePath);
        if (hash(restored) !== file.beforeHash)
          throw new Error(`The selected file failed restore verification: ${relativePath}`);
        actions.push({
          kind: file.change === "add" ? "delete-file" : "write-file",
          relativePath,
          ...(file.afterHash ? { beforeHash: file.afterHash } : {}),
          ...(file.beforeHash ? { afterHash: file.beforeHash } : {}),
          status: "applied",
        });
      }
      const reverseUses = reverseUseEffects(source);
      if (reverseUses.length) {
        const current = snapshot.relationships.uses.find(
          (use) => locationKey(use.location) === locationKey(evidence.local.location),
        );
        if (canonical(current) === canonical(reverseUses[0]!.before)) {
          const updated = await args.relationships.updateUsesExact(undefined, reverseUses);
          if (updated.status !== "saved") throw new Error("The selected managed use could not be restored exactly.");
        } else if (canonical(current) !== canonical(reverseUses[0]!.after))
          throw new Error("The selected managed use changed before restore.");
      }
      const reverseBindings = reverseBindingEffects(source);
      if (reverseBindings.length) {
        if (canonical(snapshot.binding) === canonical(reverseBindings[0]!.before)) {
          const updated = await args.bindings.updateExact(
            reverseBindings.map((change) => ({
              bindingId: change.bindingId,
              expected: change.before,
              next: change.after,
            })),
          );
          if (updated.status !== "ready") throw new Error("The selected Binding could not be restored exactly.");
        } else if (canonical(snapshot.binding) !== canonical(reverseBindings[0]!.after))
          throw new Error("The selected Binding changed before restore.");
      }
      await progress({ stepId: step.stepId, status: "verifying" });
      const verified = await read(source);
      if (
        verified.status !== "ready" ||
        verified.rootIdentities.project !== evidence.local.rootIdentity ||
        (source.files.length > 0 && canonical(verified.localTree.revision) !== canonical(evidence.local.revision))
      )
        throw new Error("The complete selected folder did not return to the reviewed local tree.");
      const use = verified.use;
      const binding = verified.binding;
      if (canonical(use) !== canonical(evidence.use) || canonical(binding) !== canonical(evidence.binding))
        throw new Error("The exact selected managed use or Binding failed restore verification.");
      const receipt = restoreReceipt(intentId, step, actions, now);
      if ((await args.operationStore.append(receipt)).status !== "ready")
        throw new Error("The managed resolution restore receipt could not be saved.");
      await markOriginalRestored(
        args.operationStore,
        saved.originalStep.stepId,
        saved.original.status === "recovery-required",
      );
      await recordParentRestored(args.operationStore, args.journal, saved.original.intentId);
      await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId });
      return {
        status: "restored",
        source: { status: "unchanged", sourceId: evidence.source.sourceId },
        targets: restoreTargets(source, "restored"),
        receiptIds: [receipt.operationId],
        receipts: [receipt],
        resolution: restoreSummary(source, "restored"),
        issues: [],
        recoveryAvailable: false,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Managed resolution restore stopped before verification.";
      await progress({ stepId: step.stepId, status: "recovery-required" });
      return {
        status: "recovery-required",
        source: { status: "unknown", sourceId: evidence.source.sourceId },
        targets: restoreTargets(source, "unknown"),
        receiptIds: [],
        resolution: restoreSummary(source, "unknown"),
        issues: [{ code: "resolution-restore-incomplete", message, recoveryAction: "inspect-recovery" }],
        recoveryAvailable: true,
      };
    }
  };
  return { preview, prepare, apply, has: (planId) => plans.has(planId) };
}

function restoreReceipt(
  intentId: string,
  step: SkillEffectStep,
  actions: readonly OperationActionReceipt[],
  now: () => number,
): OperationReceipt {
  const evidence = step.resolutionEvidence!;
  return {
    operationId: step.stepId,
    kind: "resolve-skill",
    status: "applied",
    appliedAt: new Date(now()).toISOString(),
    displayTarget: evidence.local.location.folderPath,
    actions,
    git: { mode: "disabled" },
    registered: null,
    source: { kind: "source", id: evidence.source.sourceId, relativePath: evidence.source.artifactPath },
    project: { id: evidence.local.location.projectId },
    reconciliation: { intentId, stepId: step.stepId },
  };
}
async function markOriginalRestored(
  store: OperationStore,
  operationId: string,
  interruptedBeforeReceipt: boolean,
): Promise<void> {
  const history = await store.read();
  if (history.status !== "ready") throw new Error("The original managed resolution receipt is unavailable.");
  const receipt = history.receipts.find(
    (candidate) =>
      candidate.operationId === operationId && candidate.kind === "resolve-skill" && candidate.status === "applied",
  );
  if (!receipt && interruptedBeforeReceipt) return;
  if (!receipt) throw new Error("The original managed resolution child receipt is unavailable.");
  if (!receipt.restored && (await store.append({ ...receipt, restored: true })).status !== "ready")
    throw new Error("The original managed resolution receipt could not be marked restored.");
}
