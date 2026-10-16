import { randomUUID } from "node:crypto";

import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillUseEffect } from "../../domain/skill-reconciliation/types";
import type { SkillEffectStep, SkillResult } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillRelationshipStore, SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { readSkillAdoptionSnapshot, type SkillAdoptionSnapshot } from "./adoption-reader";
import type { SkillAdoptionRequest } from "../../shared/skill-reconciliation-request";
import { recordParentRestored } from "./restore-parent";
import { adoptionRequestForRecord, verifiedLinkCanonicalAdoptionStep } from "./adoption-receipt";

type Snapshot = Extract<SkillAdoptionSnapshot, { status: "ready" }>;
type RecoveryPlan = Readonly<{
  original: SkillOperationJournalRecord;
  sourceStep: SkillEffectStep;
  effect: SkillEffectDraft;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}
function locationKey(location: SkillUseEffect["location"]): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}
function sameRevision(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
function adoptionStep(record: SkillOperationJournalRecord): SkillEffectStep {
  const step =
    record.intent.kind === "reconcile" && record.intent.request.choice === "link-canonical"
      ? verifiedLinkCanonicalAdoptionStep(record)
      : record.effect?.steps.find(
          (candidate) => candidate.metadataEffects?.length || candidate.plan.kind === "adopt-skill",
        );
  if (!step?.metadataEffects || !step.adoptionEvidence || !step.baseReferences?.length)
    throw new Error("The saved adoption recovery link is incomplete.");
  return step;
}
function inversePlan(
  original: SkillOperationJournalRecord,
  sourceStep: SkillEffectStep,
  snapshot: Snapshot,
): SkillEffectDraft {
  const currentBindings = new Map(snapshot.bindings.map((binding) => [binding.bindingId, binding]));
  const bindingAfter: boolean[] = [];
  const bindingBefore: boolean[] = [];
  for (const effect of sourceStep.bindingEffects) {
    const current = currentBindings.get(effect.bindingId);
    if (canonical(current) === canonical(effect.after)) bindingAfter.push(true);
    else if (canonical(current) === canonical(effect.before)) bindingBefore.push(true);
    else throw new Error("A touched adoption Binding changed locally; inspect recovery.");
  }
  const currentUses = new Map(snapshot.relationships.uses.map((use) => [locationKey(use.location), use]));
  const useAfter: boolean[] = [];
  const useBefore: boolean[] = [];
  for (const effect of sourceStep.metadataEffects ?? []) {
    const current = currentUses.get(locationKey(effect.location));
    if (canonical(current) === canonical(effect.after)) useAfter.push(true);
    else if (canonical(current) === canonical(effect.before)) useBefore.push(true);
    else throw new Error("A touched adoption use changed locally; inspect recovery.");
  }
  if (useAfter.length > 0 && useBefore.length > 0)
    throw new Error("Only part of the exact use update is present; inspect recovery.");
  if (bindingAfter.length > 0 && bindingBefore.length > 0)
    throw new Error("Only part of the exact Binding update is present; inspect recovery.");
  if (useAfter.length && bindingBefore.length)
    throw new Error("Adoption use metadata exists without its exact Binding; inspect recovery.");
  const bindings = bindingAfter.length
    ? sourceStep.bindingEffects.map((effect) => ({
        bindingId: effect.bindingId,
        ...(effect.after ? { before: effect.after } : {}),
        ...(effect.before ? { after: effect.before } : {}),
      }))
    : [];
  const metadata = useAfter.length
    ? (sourceStep.metadataEffects ?? []).map((effect) => ({
        skillId: effect.skillId,
        location: effect.location,
        ...(effect.after ? { before: effect.after } : {}),
        ...(effect.before ? { after: effect.before } : {}),
      }))
    : undefined;
  const targets =
    metadata?.map(({ location, before, after }) => {
      const bindingId = before?.bindingId ?? after?.bindingId;
      return { projectId: location.projectId, harnessId: location.harnessId, ...(bindingId ? { bindingId } : {}) };
    }) ?? sourceStep.scope.targets;
  const stepId = randomUUID();
  const scope = { ...sourceStep.scope, targets };
  const step: SkillEffectStep = {
    stepId,
    scope,
    plan: {
      planId: stepId,
      kind: "adopt-skill",
      displayTarget: sourceStep.plan.displayTarget,
      actions: [],
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects: bindings,
    files: [],
    ...(metadata
      ? {
          metadataEffects: metadata,
          baseReferences: sourceStep.baseReferences,
          adoptionEvidence: {
            ...sourceStep.adoptionEvidence!,
            locals: sourceStep.adoptionEvidence!.locals.filter((local) =>
              metadata.some((effect) => locationKey(effect.location) === locationKey(local.location)),
            ),
          },
        }
      : {}),
  };
  return {
    status: "ready",
    planId: stepId,
    scope,
    steps: [step],
    fingerprint: {
      scope,
      files: [],
      bindings,
      actions: [],
      ...(metadata
        ? {
            metadataEffects: metadata,
            baseReferences: sourceStep.baseReferences,
            adoptionEvidence: step.adoptionEvidence,
          }
        : {}),
    },
    backupReferences: [],
  };
}
function requestFor(record: SkillOperationJournalRecord) {
  const request = adoptionRequestForRecord(record);
  if (!request) throw new Error("The saved operation is not an exact metadata-only skill adoption.");
  return request;
}
function snapshotMatches(snapshot: Snapshot, sourceStep: SkillEffectStep): boolean {
  const saved = sourceStep.adoptionEvidence!;
  if (snapshot.rootIdentities.source !== saved.source.rootIdentity) return false;
  const localByKey = new Map(saved.locals.map((local) => [locationKey(local.location), local]));
  return (
    snapshot.localTrees.every(({ location, tree }) => {
      const expected = localByKey.get(locationKey(location));
      return Boolean(
        expected &&
        expected.rootIdentity === snapshot.rootIdentities.project &&
        sameRevision(tree.revision, expected.revision),
      );
    }) && snapshot.localTrees.length === saved.locals.length
  );
}
function verifyRestored(snapshot: Snapshot, sourceStep: SkillEffectStep): boolean {
  const bindings = new Map(snapshot.bindings.map((binding) => [binding.bindingId, binding]));
  if (
    sourceStep.bindingEffects.some((effect) => canonical(bindings.get(effect.bindingId)) !== canonical(effect.before))
  )
    return false;
  const uses = new Map(snapshot.relationships.uses.map((use) => [locationKey(use.location), use]));
  return (sourceStep.metadataEffects ?? []).every(
    (effect) => canonical(uses.get(locationKey(effect.location))) === canonical(effect.before),
  );
}
function restoredResults(step: SkillEffectStep): SkillEffectOutcome {
  const bindingEffects = step.bindingEffects;
  const targets = bindingEffects.flatMap((effect) => {
    const binding = effect.before ?? effect.after;
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
  });
  const resolution = step.metadataEffects?.length
    ? {
        skillId: step.metadataEffects[0]!.skillId,
        choice: "adopt-exact" as const,
        targets: step.metadataEffects.map((effect) => ({
          location: effect.location,
          bindingId: effect.after?.bindingId ?? effect.before!.bindingId,
          status: "restored" as const,
        })),
      }
    : undefined;
  return {
    status: "restored",
    source: { status: "unchanged", ...(step.scope.sourceId ? { sourceId: step.scope.sourceId } : {}) },
    targets,
    receiptIds: [],
    receipts: [],
    issues: [],
    recoveryAvailable: false,
    ...(resolution ? { resolution } : {}),
  };
}

export function createSkillAdoptionRecoveryAdapter(
  args: Readonly<{
    registry: RegistryIpcServices;
    relationships: SkillRelationshipStore;
    bindings: BindingsStore;
    bases: SkillBaseStore;
    operationStore: OperationStore;
    journal: import("../../application/skill-management-journal").SkillOperationJournal;
    filesystem?: SkillObservationFilesystem;
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
  const read = (record: SkillOperationJournalRecord) =>
    readSkillAdoptionSnapshot(requestFor(record), {
      registry: args.registry,
      relationships: args.relationships,
      bindings: args.bindings,
      ...(args.filesystem ? { filesystem: args.filesystem } : {}),
      now,
    });
  const preview = async (record: SkillOperationJournalRecord, intentId: string): Promise<SkillEffectBuild> => {
    try {
      const sourceStep = adoptionStep(record);
      const snapshot = await read(record);
      if (snapshot.status !== "ready" || !snapshotMatches(snapshot, sourceStep))
        throw new Error(
          snapshot.status === "ready"
            ? "Source or selected project identity/tree changed; inspect recovery."
            : snapshot.message,
        );
      if (record.status === "terminal" && record.result?.status !== "applied")
        throw new Error("This adoption did not leave an applied effect to restore.");
      const base = sourceStep.baseReferences![0]!;
      const storedBase = await args.bases.read(base.baseRevisionId);
      if (storedBase.status !== "ready" || !sameRevision(storedBase.revision, base.revision))
        throw new Error("The immutable adoption base is missing or corrupt; inspect recovery.");
      const effect = inversePlan(record, sourceStep, snapshot);
      const plan = { original: record, sourceStep, effect };
      plans.set(effect.planId, plan);
      return effect;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Adoption recovery could not be inspected safely.";
      return {
        status: "blocked",
        reason: message,
        details: [{ code: "adoption-recovery-blocked", message, recoveryAction: "inspect-recovery" }],
      };
    }
  };
  const getPlan = (planId: string): RecoveryPlan => {
    const plan = plans.get(planId);
    if (!plan) throw new Error("The adoption recovery preview expired; refresh it before applying.");
    return plan;
  };
  const revalidate = async (plan: RecoveryPlan): Promise<Snapshot> => {
    const snapshot = await read(plan.original);
    if (snapshot.status !== "ready" || !snapshotMatches(snapshot, plan.sourceStep))
      throw new Error("Source or selected project identity/tree changed after recovery preview.");
    const expected = inversePlan(plan.original, plan.sourceStep, snapshot);
    if (
      canonical(expected.steps[0]?.bindingEffects) !== canonical(plan.effect.steps[0]?.bindingEffects) ||
      canonical(expected.steps[0]?.metadataEffects) !== canonical(plan.effect.steps[0]?.metadataEffects)
    )
      throw new Error("A touched adoption Binding or use changed after recovery preview.");
    return snapshot;
  };
  const prepare = async (_intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const plan = getPlan(effect.planId);
    await revalidate(plan);
    const base = plan.sourceStep.baseReferences![0]!;
    const stored = await args.bases.read(base.baseRevisionId);
    if (stored.status !== "ready" || !sameRevision(stored.revision, base.revision))
      throw new Error("The immutable adoption base changed before recovery.");
  };
  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const plan = getPlan(effect.planId);
    const snapshot = await revalidate(plan);
    const step = effect.steps[0]!;
    await progress({ stepId: step.stepId, status: "applying" });
    if (step.metadataEffects?.length) {
      const updatedUses = await args.relationships.updateUsesExact(undefined, step.metadataEffects);
      if (updatedUses.status !== "saved")
        throw new Error("Exact managed uses could not be restored; inspect recovery.");
    }
    if (step.bindingEffects.length) {
      const updatedBindings = await args.bindings.updateExact(
        step.bindingEffects.map((change) => ({
          bindingId: change.bindingId,
          ...(change.before ? { expected: change.before } : {}),
          ...(change.after ? { next: change.after } : {}),
        })),
      );
      if (updatedBindings.status !== "ready")
        throw new Error("Exact Bindings could not be restored; inspect recovery.");
    }
    await progress({ stepId: step.stepId, status: "verifying" });
    const verified = await read(plan.original);
    if (
      verified.status !== "ready" ||
      !snapshotMatches(verified, plan.sourceStep) ||
      !verifyRestored(verified, plan.sourceStep)
    )
      throw new Error("Exact adoption metadata or selected local tree failed restoration verification.");
    const history = await args.operationStore.read();
    if (history.status !== "ready") throw new Error("The adoption restore history is unavailable.");
    const savedReceipt = history.receipts.find(
      (candidate) =>
        candidate.kind === "restore-apply" &&
        candidate.restores === plan.original.intentId &&
        candidate.status === "applied",
    );
    const receipt: OperationReceipt = savedReceipt ?? {
      operationId: randomUUID(),
      kind: "restore-apply",
      status: "applied",
      appliedAt: new Date(now()).toISOString(),
      displayTarget: step.plan.displayTarget,
      actions: [],
      git: { mode: "unavailable" },
      registered: null,
      ...(step.scope.sourceId
        ? {
            source: {
              kind: "source" as const,
              id: step.scope.sourceId,
              relativePath: step.scope.artifactPath ?? "skill",
            },
          }
        : {}),
      ...(step.scope.targets[0] ? { project: { id: step.scope.targets[0].projectId } } : {}),
      restores: plan.original.intentId,
    };
    if (!savedReceipt && (await args.operationStore.append(receipt)).status !== "ready")
      throw new Error("The adoption restore receipt could not be saved; inspect recovery.");
    const originalId = plan.sourceStep.stepId;
    if ((await args.operationStore.markRestored(originalId)).status !== "ready")
      throw new Error("The original adoption receipt could not be marked restored.");
    await recordParentRestored(args.operationStore, args.journal, plan.original.intentId);
    const result = restoredResults(step);
    const linkRequest =
      plan.original.intent.kind === "reconcile" && plan.original.intent.request.choice === "link-canonical"
        ? plan.original.intent.request
        : undefined;
    const linkBinding = step.bindingEffects[0]?.before ?? step.bindingEffects[0]?.after;
    await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId });
    return {
      ...result,
      ...(linkRequest && linkBinding
        ? {
            link: {
              choice: "link-canonical" as const,
              skillId: linkRequest.skillId,
              source: linkRequest.source,
              location: linkRequest.locations[0]!,
              bindingId: linkBinding.bindingId,
              status: "restored" as const,
            },
          }
        : {}),
      receiptIds: [receipt.operationId],
      receipts: [receipt],
    };
  };
  return { preview, prepare, apply, has: (planId) => plans.has(planId) };
}
