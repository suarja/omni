import { parseSkillLocationKey, parseSourceSkillRef } from "../domain/skill-reconciliation/validation";
import type { SkillLocationKey, SourceSkillRef } from "../domain/skill-reconciliation/types";
import { parseSkillDetachmentRequest, type SkillDetachmentRequest } from "./skill-detachment-request";
import { parseSkillVariantCaptureRequest, type SkillVariantCaptureRequest } from "./skill-variant-capture-request";
import {
  parseSkillUnboundResolutionRequest,
  type SkillUnboundResolutionRequest,
} from "./skill-unbound-resolution-request";

export type SkillAdoptionRequest = Readonly<{
  choice: "adopt-exact";
  skillId: string;
  source: SourceSkillRef;
  locations: readonly SkillLocationKey[];
}>;

export type SkillManagedResolutionChoice = "keep-local" | "use-canonical";

export type SkillManagedResolutionRequest = Readonly<{
  choice: SkillManagedResolutionChoice;
  skillId: string;
  locations: readonly [SkillLocationKey];
}>;

export type SkillReconciliationRequest =
  | SkillAdoptionRequest
  | SkillManagedResolutionRequest
  | SkillVariantCaptureRequest
  | SkillUnboundResolutionRequest
  | SkillDetachmentRequest;

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

function locationIdentity(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

export function parseSkillAdoptionRequest(value: unknown): SkillAdoptionRequest {
  const input = record(value, "Skill adoption request");
  assertKeys(input, ["choice", "skillId", "source", "locations"], "Skill adoption request");
  if (input.choice !== "adopt-exact") throw new Error("Skill adoption choice is unsupported.");
  if (typeof input.skillId !== "string" || !UUID.test(input.skillId)) throw new Error("Skill id must be a UUID.");
  if (!Array.isArray(input.locations) || input.locations.length < 1 || input.locations.length > 3) {
    throw new Error("Skill adoption locations must contain one to three exact copies.");
  }
  const locations = input.locations
    .map(parseSkillLocationKey)
    .sort((left, right) =>
      `${left.projectId}\n${left.harnessId}\n${left.folderPath}`.localeCompare(
        `${right.projectId}\n${right.harnessId}\n${right.folderPath}`,
      ),
    );
  if (new Set(locations.map(locationIdentity)).size !== locations.length)
    throw new Error("Skill adoption locations must be unique.");
  if (new Set(locations.map((location) => location.projectId)).size !== 1)
    throw new Error("Skill adoption locations must belong to one project.");
  if (new Set(locations.map((location) => location.harnessId)).size !== locations.length) {
    throw new Error("Skill adoption allows one selected copy per harness.");
  }
  return {
    choice: "adopt-exact",
    skillId: input.skillId,
    source: parseSourceSkillRef(input.source),
    locations,
  };
}

export function parseSkillManagedResolutionRequest(value: unknown): SkillManagedResolutionRequest {
  const input = record(value, "Managed skill resolution request");
  assertKeys(input, ["choice", "skillId", "locations"], "Managed skill resolution request");
  if (input.choice !== "keep-local" && input.choice !== "use-canonical") {
    throw new Error("Managed skill resolution choice is unsupported.");
  }
  if (typeof input.skillId !== "string" || !UUID.test(input.skillId)) {
    throw new Error("Skill id must be a UUID.");
  }
  if (!Array.isArray(input.locations) || input.locations.length !== 1) {
    throw new Error("Managed skill resolution requires exactly one location.");
  }
  return {
    choice: input.choice,
    skillId: input.skillId,
    locations: [parseSkillLocationKey(input.locations[0])],
  };
}

export function parseSkillReconciliationRequest(value: unknown): SkillReconciliationRequest {
  const input = record(value, "Skill reconciliation request");
  if (input.choice === "adopt-exact") return parseSkillAdoptionRequest(value);
  if (input.choice === "detach-managed") return parseSkillDetachmentRequest(value);
  if (input.choice === "keep-variant") return parseSkillVariantCaptureRequest(value);
  if (input.choice === "link-canonical") return parseSkillUnboundResolutionRequest(value);
  return parseSkillManagedResolutionRequest(value);
}
