import { parseSkillLocationKey, parseSourceSkillRef } from "../domain/skill-reconciliation/validation";
import type { SkillLocationKey, SourceSkillRef } from "../domain/skill-reconciliation/types";

export type SkillVariantCaptureRequest = Readonly<{
  choice: "keep-variant";
  skillId: string;
  locations: readonly [SkillLocationKey];
  destination: Readonly<{ sourceId: string; packageId: string; skillKey: string }>;
}>;

type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function skillKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new Error("Skill key must be a lowercase hyphenated slug.");
  }
  return value;
}

export function parseSkillVariantCaptureRequest(value: unknown): SkillVariantCaptureRequest {
  const input = record(value, "Skill variant capture request");
  keys(input, ["choice", "skillId", "locations", "destination"], "Skill variant capture request");
  if (input.choice !== "keep-variant") throw new Error("Skill variant capture choice is unsupported.");
  if (typeof input.skillId !== "string" || !UUID.test(input.skillId)) throw new Error("Skill id must be a UUID.");
  if (!Array.isArray(input.locations) || input.locations.length !== 1)
    throw new Error("Capture requires exactly one project copy.");
  const destinationInput = record(input.destination, "Skill variant destination");
  keys(destinationInput, ["sourceId", "packageId", "skillKey"], "Skill variant destination");
  const parsedSource: SourceSkillRef = parseSourceSkillRef({
    sourceId: destinationInput.sourceId,
    packageId: destinationInput.packageId,
    artifactPath: `skills/${skillKey(destinationInput.skillKey)}`,
  });
  return {
    choice: "keep-variant",
    skillId: input.skillId.toLowerCase(),
    locations: [parseSkillLocationKey(input.locations[0])],
    destination: {
      sourceId: parsedSource.sourceId,
      packageId: parsedSource.packageId,
      skillKey: parsedSource.artifactPath.slice("skills/".length),
    },
  };
}
