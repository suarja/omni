import type { ManagedSkillUse, SkillRecordEffect } from "../domain/skill-reconciliation/types";
import { parseLogicalSkillRecord, parseManagedSkillUse } from "../domain/skill-reconciliation/validation";
import { assertKeys, assertRecord, readOpaque } from "./operations-ipc-parser-utils";

export type LegacyBindingBridgeReceipt = Readonly<{
  phase: "prepared" | "applied" | "abandoned";
  uses: readonly ManagedSkillUse[];
  records: readonly SkillRecordEffect[];
}>;

export function parseLegacyBindingBridgeReceipt(value: unknown): LegacyBindingBridgeReceipt {
  const input = assertRecord(value, "Legacy Binding bridge receipt");
  assertKeys(input, ["phase", "uses", "records"], "Legacy Binding bridge receipt");
  if (
    !["prepared", "applied", "abandoned"].includes(String(input.phase)) ||
    !Array.isArray(input.uses) ||
    !input.uses.length ||
    input.uses.length > 10000 ||
    !Array.isArray(input.records) ||
    input.records.length > 10000
  )
    throw new Error("Legacy Binding bridge receipt is invalid.");
  const uses = input.uses.map(parseManagedSkillUse);
  if (
    new Set(uses.map(({ bindingId }) => bindingId)).size !== uses.length ||
    new Set(uses.map(({ location }) => JSON.stringify(location))).size !== uses.length
  )
    throw new Error("Legacy Binding bridge receipt locations must be unique.");
  const records = input.records.map((raw): SkillRecordEffect => {
    const effect = assertRecord(raw, "Legacy skill record effect");
    assertKeys(effect, ["skillId", "before", "after"], "Legacy skill record effect");
    const skillId = readOpaque(effect.skillId, "Legacy skill id");
    const before = effect.before === undefined ? undefined : parseLogicalSkillRecord(effect.before);
    const after = effect.after === undefined ? undefined : parseLogicalSkillRecord(effect.after);
    if ((!before && !after) || (before && before.skillId !== skillId) || (after && after.skillId !== skillId))
      throw new Error("Legacy skill record effect identity is invalid.");
    return { skillId, ...(before ? { before } : {}), ...(after ? { after } : {}) };
  });
  if (new Set(records.map(({ skillId }) => skillId)).size !== records.length)
    throw new Error("Legacy skill record effects must be unique.");
  return { phase: input.phase as LegacyBindingBridgeReceipt["phase"], uses, records };
}
