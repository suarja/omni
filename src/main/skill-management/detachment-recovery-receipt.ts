import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillDetachmentEvidence } from "../../shared/skill-detachment-effects";

export type SkillDetachmentSavedStep = SkillEffectStep & Readonly<{ detachmentEvidence: SkillDetachmentEvidence }>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

export function readOriginalDetachmentStep(
  record: SkillOperationJournalRecord,
  stepId?: string,
): SkillDetachmentSavedStep | undefined {
  if (record.intent.kind !== "reconcile" || record.intent.request.choice !== "detach-managed") return undefined;
  const steps = record.effect?.steps ?? [];
  if (steps.length !== 1) return undefined;
  const step = steps[0];
  if (!step || (stepId && step.stepId !== stepId) || !step.detachmentEvidence || step.detachmentRestoreOrigin)
    return undefined;
  return step as SkillDetachmentSavedStep;
}

function receiptMatchesStep(
  receipt: OperationReceipt,
  record: SkillOperationJournalRecord,
  step: SkillDetachmentSavedStep,
): boolean {
  const evidence = step.detachmentEvidence;
  const location = evidence.local.location;
  return (
    receipt.kind === "detach-skill" &&
    receipt.status === "applied" &&
    receipt.operationId === step.stepId &&
    receipt.detachment?.intentId === record.intentId &&
    receipt.detachment.stepId === step.stepId &&
    receipt.actions.length === 0 &&
    receipt.registered === null &&
    receipt.source?.kind === "source" &&
    receipt.source.id === evidence.use.source.sourceId &&
    receipt.source.relativePath === evidence.use.source.artifactPath &&
    receipt.project?.id === location.projectId &&
    !receipt.files?.length &&
    !receipt.bindings?.length &&
    !receipt.manifests?.length
  );
}

export function resolveSkillDetachmentReceipt(
  receipt: OperationReceipt,
  record: SkillOperationJournalRecord,
): SkillDetachmentSavedStep | undefined {
  const step = readOriginalDetachmentStep(record, receipt.detachment?.stepId);
  return step && receiptMatchesStep(receipt, record, step) ? step : undefined;
}

export function hasSkillDetachmentReceiptLink(
  history: readonly OperationReceipt[],
  record: SkillOperationJournalRecord,
  child: OperationReceipt,
): boolean {
  const parent = history.find(
    (receipt) => receipt.operationId === record.intentId && receipt.kind === "skill-management",
  );
  if (parent) return parent.children?.includes(child.operationId) ?? false;
  return Boolean(
    record.result?.receipts?.some((receipt) => receipt.operationId === child.operationId && same(receipt, child)),
  );
}
