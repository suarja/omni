import type { SkillOperationJournalRecord, SkillJournalRead } from "../../application/skill-management-journal";
import type { OperationReceipt } from "../../shared/operations-ipc";

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveSkillResolutionReceiptRecord(
  receipt: OperationReceipt,
  loaded: SkillJournalRead,
): SkillOperationJournalRecord | undefined {
  if (
    receipt.kind !== "resolve-skill" ||
    receipt.status !== "applied" ||
    receipt.restored ||
    !receipt.reconciliation ||
    receipt.operationId !== receipt.reconciliation.stepId ||
    loaded.status !== "ready"
  )
    return undefined;

  const record = loaded.record;
  if (
    record.intentId !== receipt.reconciliation.intentId ||
    record.intent.kind !== "reconcile" ||
    record.intent.request.choice === "adopt-exact"
  )
    return undefined;
  const request = record.intent.request;
  const step = record.effect?.steps.find((candidate) => candidate.stepId === receipt.reconciliation!.stepId);
  const evidence = step?.resolutionEvidence;
  const location = request.locations[0];
  if (
    !step ||
    step.plan.kind !== "resolve-skill" ||
    !evidence ||
    !location ||
    request.skillId !== evidence.skillId ||
    request.choice !== evidence.choice ||
    !sameRecord(location, evidence.local.location) ||
    step.scope.targets.length !== 1 ||
    step.scope.targets[0]?.projectId !== location.projectId ||
    step.scope.targets[0]?.harnessId !== location.harnessId ||
    step.scope.targets[0]?.bindingId !== evidence.use.bindingId ||
    step.scope.sourceId !== evidence.source.sourceId ||
    step.scope.packageId !== evidence.source.packageId ||
    step.scope.artifactPath !== evidence.source.artifactPath ||
    receipt.source?.kind !== "source" ||
    receipt.source.id !== evidence.source.sourceId ||
    receipt.source.relativePath !== evidence.source.artifactPath ||
    receipt.project?.id !== location.projectId ||
    receipt.actions.length !== step.plan.actions.length
  )
    return undefined;

  const savedActions = step.plan.actions.map(({ kind, relativePath, beforeHash, afterHash, byteLength }) => ({
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
  return sameRecord(savedActions, receivedActions) ? record : undefined;
}
