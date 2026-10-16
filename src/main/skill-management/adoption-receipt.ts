import type { SkillJournalRead, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillAdoptionRequest } from "../../shared/skill-reconciliation-request";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function locationKey(location: { projectId: string; harnessId: string; folderPath: string }): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function isLinkCanonicalAdoptionStep(record: SkillOperationJournalRecord, step: SkillEffectStep): boolean {
  if (record.intent.kind !== "reconcile" || record.intent.request.choice !== "link-canonical") return false;
  const request = record.intent.request;
  const location = request.locations[0];
  const metadata = step.metadataEffects;
  const base = step.baseReferences?.[0];
  const binding = step.bindingEffects[0];
  const use = metadata?.[0];
  const evidence = step.adoptionEvidence;
  const local = evidence?.locals[0];
  if (
    !location ||
    !binding?.after ||
    !use?.after ||
    !base ||
    !evidence ||
    !local ||
    !metadata ||
    metadata.length !== 1 ||
    step.baseReferences?.length !== 1 ||
    step.bindingEffects.length !== 1 ||
    step.plan.kind !== "adopt-skill" ||
    step.files.length !== 0 ||
    step.plan.actions.length !== 0 ||
    binding.before !== undefined ||
    use.before !== undefined ||
    evidence.locals.length !== 1
  )
    return false;
  return (
    evidence.source.ref.sourceId === request.source.sourceId &&
    evidence.source.ref.packageId === request.source.packageId &&
    evidence.source.ref.artifactPath === request.source.artifactPath &&
    locationKey(local.location) === locationKey(location) &&
    locationKey(use.location) === locationKey(location) &&
    use.skillId === request.skillId &&
    use.after.skillId === request.skillId &&
    same(evidence.source.revision, local.revision) &&
    same(evidence.source.revision, base.revision) &&
    use.after.source.sourceId === request.source.sourceId &&
    use.after.source.packageId === request.source.packageId &&
    use.after.source.artifactPath === request.source.artifactPath &&
    use.after.bindingId === binding.after.bindingId &&
    use.after.baseRevisionId === base.baseRevisionId &&
    binding.after.sourceId === request.source.sourceId &&
    binding.after.packageId === request.source.packageId &&
    binding.after.artifactPath === request.source.artifactPath &&
    binding.after.projectId === location.projectId &&
    binding.after.harnessId === location.harnessId &&
    step.scope.sourceId === request.source.sourceId &&
    step.scope.packageId === request.source.packageId &&
    step.scope.artifactPath === request.source.artifactPath &&
    step.scope.targets.length === 1 &&
    step.scope.targets[0]?.projectId === location.projectId &&
    step.scope.targets[0]?.harnessId === location.harnessId &&
    step.scope.targets[0]?.bindingId === binding.after.bindingId &&
    step.resolutionEvidence === undefined &&
    step.variantCaptureEvidence === undefined &&
    step.unboundResolutionEvidence === undefined &&
    step.unboundResolutionEnvelope === undefined
  );
}

export function verifiedLinkCanonicalAdoptionStep(record: SkillOperationJournalRecord): SkillEffectStep | undefined {
  if (record.intent.kind !== "reconcile" || record.intent.request.choice !== "link-canonical") return undefined;
  const steps = record.effect?.steps.filter((candidate) => isLinkCanonicalAdoptionStep(record, candidate)) ?? [];
  return steps.length === 1 ? steps[0] : undefined;
}

export function adoptionRequestForRecord(record: SkillOperationJournalRecord): SkillAdoptionRequest | undefined {
  if (record.intent.kind !== "reconcile") return undefined;
  const request = record.intent.request;
  if (request.choice === "adopt-exact") return request;
  if (request.choice !== "link-canonical") return undefined;
  if (!verifiedLinkCanonicalAdoptionStep(record)) return undefined;
  return {
    choice: "adopt-exact",
    skillId: request.skillId,
    source: request.source,
    locations: [request.locations[0]!],
  };
}

export function resolveAdoptionReceiptRecord(
  receipt: OperationReceipt,
  loaded: SkillJournalRead,
): SkillOperationJournalRecord | undefined {
  if (
    receipt.kind !== "adopt-skill" ||
    receipt.status !== "applied" ||
    receipt.restored ||
    !receipt.adoption ||
    receipt.operationId !== receipt.adoption.stepId ||
    receipt.actions.length !== 0 ||
    loaded.status !== "ready"
  )
    return undefined;
  const record = loaded.record;
  if (
    record.intentId !== receipt.adoption.intentId ||
    record.intent.kind !== "reconcile" ||
    !adoptionRequestForRecord(record)
  )
    return undefined;
  const request = adoptionRequestForRecord(record)!;
  const step = record.effect?.steps.find((candidate) => candidate.stepId === receipt.adoption!.stepId);
  if (
    !step ||
    step.plan.kind !== "adopt-skill" ||
    step.files.length !== 0 ||
    step.scope.sourceId !== request.source.sourceId ||
    step.scope.packageId !== request.source.packageId ||
    receipt.source?.kind !== "source" ||
    receipt.source.id !== request.source.sourceId ||
    receipt.source.relativePath !== request.source.artifactPath ||
    receipt.project?.id !== request.locations[0]?.projectId ||
    !step.metadataEffects?.length ||
    step.metadataEffects.some(
      (effect) => effect.skillId !== request.skillId || effect.location.projectId !== receipt.project!.id,
    )
  )
    return undefined;
  return record;
}
