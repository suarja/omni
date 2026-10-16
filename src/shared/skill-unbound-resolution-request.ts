import { parseSkillLocationKey, parseSourceSkillRef } from "../domain/skill-reconciliation/validation";
import type { SkillLocationKey, SourceSkillRef } from "../domain/skill-reconciliation/types";

export type SkillUnboundResolutionRequest = Readonly<{
  choice: "link-canonical";
  skillId: string;
  source: SourceSkillRef;
  locations: readonly [SkillLocationKey];
}>;

type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function assertKeys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

export function parseSkillUnboundResolutionRequest(value: unknown): SkillUnboundResolutionRequest {
  const input = record(value, "Unbound skill resolution request");
  assertKeys(input, ["choice", "skillId", "source", "locations"], "Unbound skill resolution request");
  if (input.choice !== "link-canonical") throw new Error("Unbound skill resolution choice is unsupported.");
  if (typeof input.skillId !== "string" || !UUID.test(input.skillId)) throw new Error("Skill id must be a UUID.");
  if (!Array.isArray(input.locations) || input.locations.length !== 1)
    throw new Error("Unbound skill resolution requires exactly one location.");
  return {
    choice: "link-canonical",
    skillId: input.skillId,
    source: parseSourceSkillRef(input.source),
    locations: [parseSkillLocationKey(input.locations[0])],
  };
}
