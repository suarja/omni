import { createHash } from "node:crypto";

import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournal, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { OperationActionReceipt, OperationReceipt } from "../../shared/operations-ipc";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { PreparedVariantPayload } from "./variant-publication";
import { readPreparedVariantPayload, restoreVariantPublication } from "./variant-publication";
import { inspectVariantPublication } from "./variant-publication-inspection";
import { readSkillVariantManifestSnapshot } from "./variant-origin-reader";

import { skillRootIdentity } from "./adoption-reader";

import { recordParentRestored } from "./restore-parent";

import {
  canonical,
  uuid,
  digest,
  originalCaptureStep,
  resolveSkillVariantCaptureReceiptRecord,
  expectedSourceBindings,
  priorRestoreRecord,
  validateReceiptOrJournalState,
  validateManifest,
  selectedVariantBindingOrUseExists,
  originalMetadataMatches,
  buildRestoreEffect,
  type CaptureStep,
} from "./variant-recovery-policy";
export { resolveSkillVariantCaptureReceiptRecord } from "./variant-recovery-policy";
type RecoveryPlan = Readonly<{
  original: SkillOperationJournalRecord;
  originalStep: CaptureStep;
  effect: SkillEffectDraft;
  receipt?: OperationReceipt;
  presentFiles: readonly string[];
  createdDirectories: readonly Readonly<{ relativePath: string; identity: string }>[];
  stateKey: string;
  baseSnapshot?: Readonly<{ revision: unknown; files: readonly Readonly<{ path: string; hash: string }>[] }>;
}>;

export function createSkillVariantRecoveryAdapter(
  args: Readonly<{
    userDataPath: string;
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    journal: SkillOperationJournal;
    now?: () => number;
  }>,
): Readonly<{
  preview(record: SkillOperationJournalRecord, intentId: string, receipt?: OperationReceipt): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const now = args.now ?? Date.now;
  const plans = new Map<string, RecoveryPlan>();
  const inspect = async (record: SkillOperationJournalRecord, step: CaptureStep, receipt?: OperationReceipt) => {
    const payload = await readPreparedVariantPayload(args.userDataPath, record.intentId);
    if (!payload)
      throw new Error("The saved capture payload is missing or corrupt; no destination changes can be removed safely.");
    const variantSource = step.variantCaptureEvidence.destination.source;
    const manifestSnapshot = await readSkillVariantManifestSnapshot(variantSource, { registry: args.registry, now });
    if (!manifestSnapshot) throw new Error("The captured personal source is no longer available.");
    if (
      manifestSnapshot.packageRoot !== step.variantCaptureEvidence.destination.packageRoot ||
      manifestSnapshot.manifestPath !== payload.index.manifest.relativePath ||
      manifestSnapshot.rootIdentity !== step.variantCaptureEvidence.destination.rootIdentity ||
      skillRootIdentity(manifestSnapshot.grant, (value) => createHash("sha256").update(value, "utf8").digest("hex")) !==
        step.variantCaptureEvidence.destination.rootIdentity
    )
      throw new Error("The selected personal source root or exact plugin package changed after capture.");
    const inspection = await inspectVariantPublication({ grant: manifestSnapshot.grant, payload });
    validateManifest(manifestSnapshot, step, inspection);
    const journalRead = await args.journal.list();
    if (journalRead.status !== "ready")
      throw new Error("The skill journal is unavailable for inverse progress verification.");
    const priorRestore = priorRestoreRecord(journalRead.records, record, step);
    const createdDirectories = validateReceiptOrJournalState(record, step, payload, inspection, receipt, priorRestore);
    const [relationshipRead, bindingRead] = await Promise.all([args.relationships.read(), args.bindings.read()]);
    if (!originalMetadataMatches(step, relationshipRead, bindingRead))
      throw new Error("The original skill record, managed use or Binding changed after capture.");
    if (selectedVariantBindingOrUseExists(step, relationshipRead, bindingRead))
      throw new Error("The captured variant has a later managed use or Binding; remove that reference before restore.");
    let baseSnapshot: RecoveryPlan["baseSnapshot"];
    const use = step.variantCaptureEvidence.use;
    if (use) {
      const base = await args.bases.read(use.baseRevisionId);
      if (base.status !== "ready") throw new Error("The original managed base is unavailable; restore is withheld.");
      baseSnapshot = {
        revision: base.revision,
        files: [...base.files]
          .map(([path, bytes]) => ({ path, hash: digest(bytes) }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      };
    }
    const location = step.variantCaptureEvidence.request.locations[0]!;
    const selectedUses =
      relationshipRead.status === "ready"
        ? relationshipRead.state.uses.filter((item) => canonical(item.location) === canonical(location))
        : undefined;
    const variantUses =
      relationshipRead.status === "ready"
        ? relationshipRead.state.uses.filter(
            (item) =>
              item.source.sourceId === variantSource.sourceId &&
              item.source.packageId === variantSource.packageId &&
              item.source.artifactPath === variantSource.artifactPath,
          )
        : undefined;
    const selectedBindingId = step.variantCaptureEvidence.binding?.bindingId;
    const selectedBindings =
      bindingRead.status === "ready"
        ? bindingRead.bindings.filter((item) => item.bindingId === selectedBindingId)
        : undefined;
    const variantBindings =
      bindingRead.status === "ready" ? expectedSourceBindings(step, bindingRead.bindings) : undefined;
    const originalRecord =
      relationshipRead.status === "ready"
        ? relationshipRead.state.skills.find(({ skillId }) => skillId === step.variantCaptureEvidence.request.skillId)
        : undefined;
    const stateKey = canonical({
      manifestState: inspection.manifestState,
      presentFiles: inspection.presentFiles,
      presentDirectories: inspection.presentDirectories,
      manifestHash: digest(inspection.manifestBytes),
      priorRestore: priorRestore ? { updatedAt: priorRestore.updatedAt, steps: priorRestore.steps } : undefined,
      originalRecord,
      selectedUses,
      selectedBindings,
      variantUses,
      variantBindings,
      baseSnapshot,
    });
    return { payload, inspection, manifestSnapshot, createdDirectories, stateKey, baseSnapshot };
  };
  const preview = async (
    record: SkillOperationJournalRecord,
    intentId: string,
    receipt?: OperationReceipt,
  ): Promise<SkillEffectBuild> => {
    try {
      const step = originalCaptureStep(record);
      if (!receipt) {
        const history = await args.operationStore.read();
        if (history.status !== "ready") throw new Error("The capture receipt store is unavailable.");
        receipt = history.receipts.find(
          (candidate) =>
            candidate.kind === "capture-skill" &&
            candidate.capture?.intentId === record.intentId &&
            candidate.operationId === step.stepId &&
            candidate.status === "applied" &&
            !candidate.restored,
        );
      }
      const state = await inspect(record, step, receipt);
      if (
        record.status === "terminal" &&
        record.result?.status !== "applied" &&
        record.result?.status !== "recovery-required"
      )
        throw new Error("This capture has no published variant to restore.");
      const effect = buildRestoreEffect(record, step, state.payload, state.inspection, intentId);
      plans.set(effect.planId, {
        original: record,
        originalStep: step,
        effect,
        ...(receipt ? { receipt } : {}),
        presentFiles: state.inspection.presentFiles,
        createdDirectories: state.createdDirectories,
        stateKey: state.stateKey,
        ...(state.baseSnapshot ? { baseSnapshot: state.baseSnapshot } : {}),
      });
      return effect;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Personal variant recovery could not be inspected safely.";
      return {
        status: "blocked",
        reason: message,
        details: [{ code: "variant-recovery-blocked", message, recoveryAction: "inspect-recovery" }],
      };
    }
  };
  const getPlan = (effect: SkillEffectDraft): RecoveryPlan => {
    const saved = plans.get(effect.planId);
    if (!saved || saved.effect.steps[0]?.stepId !== effect.steps[0]?.stepId)
      throw new Error("The personal variant recovery preview expired; refresh before restore.");
    return saved;
  };
  const validate = async (saved: RecoveryPlan) => {
    const current = await inspect(saved.original, saved.originalStep, saved.receipt);
    if (
      current.stateKey !== saved.stateKey ||
      canonical(current.inspection.presentFiles) !== canonical(saved.presentFiles) ||
      canonical(current.createdDirectories) !== canonical(saved.createdDirectories) ||
      canonical(current.baseSnapshot) !== canonical(saved.baseSnapshot)
    )
      throw new Error("The destination, saved progress or original management records changed after recovery review.");
    return current;
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
    const step = effect.steps[0]!;
    try {
      const current = await validate(saved);
      await progress({ stepId: step.stepId, status: "applying" });
      await restoreVariantPublication({
        grant: current.manifestSnapshot.grant,
        payload: current.payload,
        createdDirectories: current.createdDirectories,
        presentFiles: current.inspection.presentFiles,
        progress: async (actions) => progress({ stepId: step.stepId, status: "applying", actions }),
        beforeEffect: async () => {
          const snapshot = await readSkillVariantManifestSnapshot(
            saved.originalStep.variantCaptureEvidence.destination.source,
            { registry: args.registry, now },
          );
          if (
            !snapshot ||
            snapshot.rootIdentity !== saved.originalStep.variantCaptureEvidence.destination.rootIdentity ||
            snapshot.manifestPath !== current.payload.index.manifest.relativePath ||
            ![current.payload.index.manifest.beforeHash, current.payload.index.manifest.afterHash].includes(
              snapshot.manifestHash,
            )
          )
            throw new Error("The reviewed personal source or manifest changed during restore.");
          const [relationships, bindings] = await Promise.all([args.relationships.read(), args.bindings.read()]);
          if (
            !originalMetadataMatches(saved.originalStep, relationships, bindings) ||
            selectedVariantBindingOrUseExists(saved.originalStep, relationships, bindings)
          )
            throw new Error("Skill management references changed during restore; remaining changes are withheld.");
        },
      });
      const verified = await inspect(saved.original, saved.originalStep, saved.receipt);
      if (verified.inspection.manifestState !== "before" || verified.inspection.presentFiles.length !== 0)
        throw new Error("The captured variant did not return to its saved before-state.");
      const history = await args.operationStore.read();
      if (history.status !== "ready") throw new Error("The variant restore receipt store is unavailable.");
      const restoreReceipt = history.receipts.find(
        (candidate) =>
          candidate.kind === "restore-apply" &&
          candidate.restores === saved.original.intentId &&
          candidate.status === "applied",
      ) ?? {
        operationId: uuid(`${saved.original.intentId}\nvariant-restore-receipt`),
        kind: "restore-apply" as const,
        status: "applied" as const,
        appliedAt: new Date(now()).toISOString(),
        displayTarget: saved.originalStep.plan.displayTarget,
        actions: step.plan.actions.map((action): OperationActionReceipt => ({ ...action, status: "applied" })),
        git: { mode: "disabled" as const },
        registered: null,
        source: {
          kind: "source" as const,
          id: saved.originalStep.variantCaptureEvidence.destination.source.sourceId,
          relativePath: saved.originalStep.variantCaptureEvidence.destination.source.artifactPath,
        },
        restores: saved.original.intentId,
      };
      if (
        !history.receipts.some(({ operationId }) => operationId === restoreReceipt.operationId) &&
        (await args.operationStore.append(restoreReceipt)).status !== "ready"
      )
        throw new Error("The variant restore receipt could not be saved.");
      if (saved.receipt && (await args.operationStore.markRestored(saved.originalStep.stepId)).status !== "ready")
        throw new Error("The original capture receipt could not be marked restored.");
      if (
        history.receipts.some(
          (candidate) => candidate.operationId === saved.original.intentId && candidate.kind === "skill-management",
        )
      )
        await recordParentRestored(args.operationStore, args.journal, saved.original.intentId);
      await progress({ stepId: step.stepId, status: "applied", receiptId: restoreReceipt.operationId });
      const evidence = saved.originalStep.variantCaptureEvidence;
      return {
        status: "restored",
        source: { status: "restored", sourceId: evidence.destination.source.sourceId },
        targets: [],
        receiptIds: [restoreReceipt.operationId],
        receipts: [restoreReceipt],
        capture: {
          choice: "keep-variant",
          skillId: evidence.request.skillId,
          variantId: evidence.origin.variantId,
          location: evidence.request.locations[0]!,
          destination: evidence.destination.source,
          status: "restored",
        },
        issues: [],
        recoveryAvailable: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Personal variant restore failed.";
      await progress({ stepId: step.stepId, status: "recovery-required" }).catch(() => undefined);
      const evidence = saved.originalStep.variantCaptureEvidence;
      return {
        status: "recovery-required",
        source: { status: "unknown", sourceId: evidence.destination.source.sourceId },
        targets: [],
        receiptIds: [],
        capture: {
          choice: "keep-variant",
          skillId: evidence.request.skillId,
          variantId: evidence.origin.variantId,
          location: evidence.request.locations[0]!,
          destination: evidence.destination.source,
          status: "unknown",
        },
        issues: [{ code: "variant-restore-incomplete", message, recoveryAction: "inspect-recovery" }],
        recoveryAvailable: true,
      };
    }
  };
  return { preview, prepare, apply, has: (planId) => plans.has(planId) };
}
