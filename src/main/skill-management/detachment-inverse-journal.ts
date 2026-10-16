import type { SkillOperationJournal, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectOutcome } from "../../application/skill-management";
import type { OperationStore } from "../operation-store";
import type { SkillDetachmentSavedStep } from "./detachment-recovery-receipt";
import { createSkillDetachmentReceipt } from "./detachment-receipt";
import type { OperationReceipt } from "../../shared/operations-ipc";

export type InterruptedDetachmentInverse = Readonly<{
  record: SkillOperationJournalRecord;
  step: SkillDetachmentSavedStep;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function linkedInverses(
  records: readonly SkillOperationJournalRecord[],
  original: SkillOperationJournalRecord,
  step: SkillDetachmentSavedStep,
): readonly InterruptedDetachmentInverse[] {
  const linked: InterruptedDetachmentInverse[] = [];
  for (const record of records) {
    if (record.intent.kind !== "restore" || record.status !== "recovery-required") continue;
    const candidates =
      record.effect?.steps.filter(
        (candidate) =>
          candidate.detachmentRestoreOrigin?.intentId === original.intentId &&
          candidate.detachmentRestoreOrigin.stepId === step.stepId,
      ) ?? [];
    if (!candidates.length) continue;
    const candidate = candidates[0];
    if (
      record.actor.kind !== "desktop" ||
      candidates.length !== 1 ||
      record.effect?.steps.length !== 1 ||
      !candidate?.detachmentEvidence ||
      canonical(candidate.detachmentEvidence) !== canonical(step.detachmentEvidence)
    )
      throw new Error("An interrupted management inverse has conflicting saved evidence.");
    linked.push({ record, step: candidate as SkillDetachmentSavedStep });
  }
  return linked;
}

export async function readInterruptedDetachmentInverse(
  journal: SkillOperationJournal,
  original: SkillOperationJournalRecord,
  step: SkillDetachmentSavedStep,
): Promise<InterruptedDetachmentInverse | undefined> {
  const read = await journal.list();
  if (read.status !== "ready") throw new Error("Management inverse journals are unavailable or corrupt.");
  const candidates = [...linkedInverses(read.records, original, step)].sort((left, right) =>
    right.record.createdAt.localeCompare(left.record.createdAt),
  );
  if (candidates.length > 1 && candidates[0].record.createdAt === candidates[1].record.createdAt)
    throw new Error("Management inverse ordering is ambiguous; recovery is withheld.");
  return candidates[0];
}

export function readInterruptedDetachmentReceipt(
  history: readonly OperationReceipt[],
  inverse: InterruptedDetachmentInverse | undefined,
  sourceReceipt: OperationReceipt | undefined,
): OperationReceipt | undefined {
  if (!inverse) return undefined;
  const existing = history.find((receipt) => receipt.operationId === inverse.step.stepId);
  if (!existing) return undefined;
  const expected = createSkillDetachmentReceipt(
    inverse.record.intentId,
    inverse.step,
    () => Date.parse(existing.appliedAt),
    sourceReceipt?.operationId,
  );
  if (canonical(existing) !== canonical(expected))
    throw new Error("The interrupted inverse receipt conflicts with its saved metadata-only step.");
  return existing;
}

export async function closeInterruptedDetachmentInverses(
  args: Readonly<{
    journal: SkillOperationJournal;
    operationStore: OperationStore;
    original: SkillOperationJournalRecord;
    step: SkillDetachmentSavedStep;
    result: SkillEffectOutcome;
    now: () => number;
  }>,
): Promise<void> {
  const read = await args.journal.list();
  const history = await args.operationStore.read();
  if (read.status !== "ready" || history.status !== "ready")
    throw new Error("Completed management inverse history cannot be verified.");
  for (const { record } of linkedInverses(read.records, args.original, args.step)) {
    const result = { ...args.result, intentId: record.intentId, operationId: record.intentId };
    const parent = history.receipts.find(
      (receipt) => receipt.operationId === record.intentId && receipt.skillManagement,
    );
    if (parent) {
      const { receipts: _receipts, ...summary } = result;
      const updated = { ...parent, restored: true, children: result.receiptIds, skillManagement: summary };
      const stored = await args.operationStore.append(updated);
      if (stored.status !== "ready" || !stored.receipts.some((receipt) => canonical(receipt) === canonical(updated)))
        throw new Error("The completed interrupted inverse summary could not be durably verified.");
    }
    await args.journal.write({
      ...record,
      status: "terminal",
      result,
      updatedAt: new Date(args.now()).toISOString(),
      steps: record.steps.map((saved) => ({ ...saved, status: "applied" })),
    });
  }
}
