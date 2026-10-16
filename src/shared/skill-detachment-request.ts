import { parseSkillLocationKey } from "../domain/skill-reconciliation/validation";
import type { SkillLocationKey } from "../domain/skill-reconciliation/types";

export type SkillDetachmentRequest = Readonly<{
  choice: "detach-managed";
  skillId: string;
  locations: readonly [SkillLocationKey];
}>;

type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Skill detachment request must be an object.");
  return value as RecordValue;
}

export function parseSkillDetachmentRequest(value: unknown): SkillDetachmentRequest {
  const input = record(value);
  if (Object.keys(input).some((key) => !["choice", "skillId", "locations"].includes(key)))
    throw new Error("Skill detachment request has an unexpected field.");
  if (input.choice !== "detach-managed") throw new Error("Skill detachment choice is unsupported.");
  if (typeof input.skillId !== "string" || !UUID.test(input.skillId)) throw new Error("Skill id must be a UUID.");
  if (!Array.isArray(input.locations) || input.locations.length !== 1)
    throw new Error("Skill detachment requires exactly one location.");
  return {
    choice: "detach-managed",
    skillId: input.skillId,
    locations: [parseSkillLocationKey(input.locations[0])],
  };
}
