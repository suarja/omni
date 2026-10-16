import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillAuthorization } from "../../shared/skill-management-ipc";
import { assertDesktopDetachmentAuthorization } from "./detachment-access";

type Validator = Readonly<{ validateAuthorization(record: SkillOperationJournalRecord): Promise<void> }>;
export async function validateMainSkillAuthorization(
  record: SkillOperationJournalRecord,
  authorization: SkillAuthorization,
  adapters: Readonly<{ variantCapture?: Validator; propagation?: Validator }>,
): Promise<void> {
  assertDesktopDetachmentAuthorization(record, authorization);
  await adapters.variantCapture?.validateAuthorization(record);
  if (record.intent.kind === "update-and-maintain" || record.intent.kind === "maintain-current") {
    if (!adapters.propagation) throw new Error("Skill propagation is unavailable in this session.");
    await adapters.propagation.validateAuthorization(record);
  }
  if (record.effectFingerprint !== authorization.effectFingerprint)
    throw new Error("Approval does not cover the current skill effects.");
  if (
    authorization.kind === "agent" &&
    (record.actor.kind !== "mcp" || record.actor.requestId !== authorization.requestId)
  )
    throw new Error("Agent approval does not match the saved request.");
}
