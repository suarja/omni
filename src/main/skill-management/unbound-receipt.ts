import type { SkillJournalRead, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { OperationReceipt } from "../../shared/operations-ipc";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveSkillUnboundResolutionReceiptRecord(
  receipt: OperationReceipt,
  loaded: SkillJournalRead,
): SkillOperationJournalRecord | undefined {
  if (
    receipt.kind !== "link-skill" ||
    receipt.status !== "applied" ||
    receipt.restored ||
    !receipt.link ||
    receipt.operationId !== receipt.link.stepId ||
    loaded.status !== "ready"
  )
    return undefined;
  const record = loaded.record;
  if (
    record.intentId !== receipt.link.intentId ||
    record.intent.kind !== "reconcile" ||
    record.intent.request.choice !== "link-canonical"
  )
    return undefined;
  const request = record.intent.request;
  const location = request.locations[0];
  const step = record.effect?.steps.find((candidate) => candidate.stepId === receipt.link!.stepId);
  const evidence = step?.unboundResolutionEvidence;
  if (
    !step ||
    step.plan.kind !== "link-skill" ||
    !evidence ||
    !location ||
    evidence.choice !== "link-canonical" ||
    evidence.skillId !== request.skillId ||
    !same(evidence.source.ref, request.source) ||
    !same(evidence.local.location, location) ||
    !same(
      evidence.record.locations.find((candidate) => same(candidate, location)),
      location,
    ) ||
    evidence.priorManagement.use !== "absent" ||
    evidence.priorManagement.binding !== "absent" ||
    evidence.priorManagement.base !== "unknown" ||
    step.scope.targets.length !== 1 ||
    step.scope.targets[0]?.projectId !== location.projectId ||
    step.scope.targets[0]?.harnessId !== location.harnessId ||
    step.scope.targets[0]?.bindingId !== step.bindingEffects[0]?.after?.bindingId ||
    step.scope.sourceId !== request.source.sourceId ||
    step.scope.packageId !== request.source.packageId ||
    step.scope.artifactPath !== request.source.artifactPath ||
    receipt.source?.kind !== "source" ||
    receipt.source.id !== request.source.sourceId ||
    receipt.source.relativePath !== request.source.artifactPath ||
    receipt.project?.id !== location.projectId ||
    receipt.actions.length !== step.plan.actions.length
  )
    return undefined;
  const expectedActions = step.plan.actions.map(({ kind, relativePath, beforeHash, afterHash, byteLength }) => ({
    kind,
    relativePath,
    ...(beforeHash === undefined ? {} : { beforeHash }),
    ...(afterHash === undefined ? {} : { afterHash }),
    ...(byteLength === undefined ? {} : { byteLength }),
  }));
  const receivedActions = receipt.actions.map(({ kind, relativePath, beforeHash, afterHash, byteLength }) => ({
    kind,
    relativePath,
    ...(beforeHash === undefined ? {} : { beforeHash }),
    ...(afterHash === undefined ? {} : { afterHash }),
    ...(byteLength === undefined ? {} : { byteLength }),
  }));
  const binding = step.bindingEffects[0]?.after;
  const receivedBinding = receipt.bindings?.find((candidate) => candidate.bindingId === binding?.bindingId)?.after;
  return binding && same(expectedActions, receivedActions) && same(binding, receivedBinding) ? record : undefined;
}
