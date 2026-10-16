import {
  parseManagedSkillUse,
  parseSkillLocationKey,
  parseSkillRevision,
  parseSourceSkillRef,
} from "../domain/skill-reconciliation/validation";
import type {
  SkillLocationKey,
  SkillRevision,
  SkillUseEffect,
  SourceSkillRef,
} from "../domain/skill-reconciliation/types";
import type { SkillScope } from "./skill-management-ipc";

export type SkillAdoptionBaseReference = Readonly<{ baseRevisionId: string; revision: SkillRevision }>;
export type SkillAdoptionEvidence = Readonly<{
  storeRevision: number;
  source: Readonly<{ ref: SourceSkillRef; rootIdentity: string; revision: SkillRevision }>;
  locals: readonly Readonly<{ location: SkillLocationKey; rootIdentity: string; revision: SkillRevision }>[];
}>;
export type SkillAdoptionResolution = Readonly<{
  skillId: string;
  choice: "adopt-exact";
  targets: readonly Readonly<{
    location: SkillLocationKey;
    bindingId: string;
    status: "applied" | "no-op" | "restored" | "failed" | "unknown";
  }>[];
}>;
export type SkillAdoptionStepMetadata = Readonly<{
  metadataEffects: readonly SkillUseEffect[];
  baseReferences: readonly SkillAdoptionBaseReference[];
  adoptionEvidence: SkillAdoptionEvidence;
}>;

type RecordValue = Record<string, unknown>;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function assertKeys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function locationIdentity(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

export function parseSkillUseEffect(value: unknown): SkillUseEffect {
  const input = record(value, "Skill use effect");
  assertKeys(input, ["skillId", "location", "before", "after"], "Skill use effect");
  const skillId = identifier(input.skillId, "Skill id");
  if (!UUID.test(skillId) || (input.before === undefined && input.after === undefined))
    throw new Error("Skill use effect is empty or invalid.");
  const location = parseSkillLocationKey(input.location);
  const before = input.before === undefined ? undefined : parseManagedSkillUse(input.before);
  const after = input.after === undefined ? undefined : parseManagedSkillUse(input.after);
  for (const use of [before, after]) {
    if (use && (use.skillId !== skillId || locationIdentity(use.location) !== locationIdentity(location))) {
      throw new Error("Skill use effect does not match its exact location.");
    }
  }
  return { skillId, location, ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

export function parseSkillAdoptionBaseReference(value: unknown): SkillAdoptionBaseReference {
  const input = record(value, "Skill adoption base reference");
  assertKeys(input, ["baseRevisionId", "revision"], "Skill adoption base reference");
  if (typeof input.baseRevisionId !== "string" || !UUID.test(input.baseRevisionId))
    throw new Error("Base revision id must be a UUID.");
  return { baseRevisionId: input.baseRevisionId, revision: parseSkillRevision(input.revision) };
}

export function parseSkillAdoptionEvidence(value: unknown): SkillAdoptionEvidence {
  const input = record(value, "Skill adoption evidence");
  assertKeys(input, ["storeRevision", "source", "locals"], "Skill adoption evidence");
  if (
    !Number.isSafeInteger(input.storeRevision) ||
    Number(input.storeRevision) < 0 ||
    !Array.isArray(input.locals) ||
    input.locals.length < 1 ||
    input.locals.length > 3
  ) {
    throw new Error("Skill adoption evidence metadata is invalid.");
  }
  const sourceInput = record(input.source, "Skill adoption source evidence");
  assertKeys(sourceInput, ["ref", "rootIdentity", "revision"], "Skill adoption source evidence");
  const source = {
    ref: parseSourceSkillRef(sourceInput.ref),
    rootIdentity: parseIdentity(sourceInput.rootIdentity, "Source root identity"),
    revision: parseSkillRevision(sourceInput.revision),
  };
  const locals = input.locals
    .map((value) => {
      const local = record(value, "Skill adoption local evidence");
      assertKeys(local, ["location", "rootIdentity", "revision"], "Skill adoption local evidence");
      return {
        location: parseSkillLocationKey(local.location),
        rootIdentity: parseIdentity(local.rootIdentity, "Project root identity"),
        revision: parseSkillRevision(local.revision),
      };
    })
    .sort((left, right) => locationIdentity(left.location).localeCompare(locationIdentity(right.location)));
  if (new Set(locals.map(({ location }) => locationIdentity(location))).size !== locals.length)
    throw new Error("Skill adoption evidence locations are duplicated.");
  if (
    new Set(locals.map(({ location }) => location.projectId)).size !== 1 ||
    new Set(locals.map(({ location }) => location.harnessId)).size !== locals.length
  ) {
    throw new Error("Skill adoption evidence must describe one project and distinct harnesses.");
  }
  return { storeRevision: Number(input.storeRevision), source, locals };
}

export function parseSkillAdoptionResolution(value: unknown): SkillAdoptionResolution {
  const input = record(value, "Skill adoption resolution");
  assertKeys(input, ["skillId", "choice", "targets"], "Skill adoption resolution");
  const skillId = identifier(input.skillId, "Skill id");
  if (
    !UUID.test(skillId) ||
    input.choice !== "adopt-exact" ||
    !Array.isArray(input.targets) ||
    input.targets.length < 1 ||
    input.targets.length > 3
  ) {
    throw new Error("Skill adoption resolution is invalid.");
  }
  const targets = input.targets
    .map((value) => {
      const target = record(value, "Skill adoption target result");
      assertKeys(target, ["location", "bindingId", "status"], "Skill adoption target result");
      const statuses = ["applied", "no-op", "restored", "failed", "unknown"];
      if (!statuses.includes(String(target.status))) throw new Error("Skill adoption target status is invalid.");
      return {
        location: parseSkillLocationKey(target.location),
        bindingId: identifier(target.bindingId, "Binding id"),
        status: target.status as SkillAdoptionResolution["targets"][number]["status"],
      };
    })
    .sort((left, right) => locationIdentity(left.location).localeCompare(locationIdentity(right.location)));
  if (
    new Set(targets.map(({ location }) => locationIdentity(location))).size !== targets.length ||
    new Set(targets.map(({ bindingId }) => bindingId)).size !== targets.length
  ) {
    throw new Error("Skill adoption targets must be unique.");
  }
  return { skillId, choice: "adopt-exact", targets };
}

export function parseSkillAdoptionStepMetadata(
  value: Readonly<Record<string, unknown>>,
  scope: SkillScope,
  fileCount: number,
  actionCount: number,
): SkillAdoptionStepMetadata | undefined {
  const present = [value.metadataEffects, value.baseReferences, value.adoptionEvidence].some(
    (field) => field !== undefined,
  );
  if (!present) return undefined;
  if (
    !Array.isArray(value.metadataEffects) ||
    !Array.isArray(value.baseReferences) ||
    value.adoptionEvidence === undefined ||
    fileCount > 0 ||
    actionCount > 0
  ) {
    throw new Error("Skill adoption effects must be metadata-only and carry complete evidence.");
  }
  const metadataEffects = value.metadataEffects.map(parseSkillUseEffect);
  const baseReferences = value.baseReferences.map(parseSkillAdoptionBaseReference);
  const adoptionEvidence = parseSkillAdoptionEvidence(value.adoptionEvidence);
  if (!metadataEffects.length || baseReferences.length !== 1) throw new Error("Skill adoption metadata is incomplete.");
  const locations = metadataEffects.map(({ location }) => locationIdentity(location));
  if (new Set(locations).size !== locations.length) throw new Error("Skill metadata effects are duplicated.");
  const targets = new Set(scope.targets.map(({ projectId, harnessId }) => `${projectId}\n${harnessId}`));
  if (metadataEffects.some(({ location }) => !targets.has(`${location.projectId}\n${location.harnessId}`))) {
    throw new Error("Skill adoption metadata exceeds its selected scope.");
  }
  const source = adoptionEvidence.source.ref;
  if (
    scope.targets.length !== metadataEffects.length ||
    !scope.sourceId ||
    !scope.packageId ||
    !scope.artifactPath ||
    source.sourceId !== scope.sourceId ||
    source.packageId !== scope.packageId ||
    source.artifactPath !== scope.artifactPath
  ) {
    throw new Error("Skill adoption evidence does not match its source or selected scope.");
  }
  const expectedLocations = new Set(adoptionEvidence.locals.map(({ location }) => locationIdentity(location)));
  if (locations.some((location) => !expectedLocations.has(location)) || expectedLocations.size !== locations.length) {
    throw new Error("Skill adoption evidence does not match its selected locations.");
  }
  const sourceRevision = JSON.stringify(adoptionEvidence.source.revision);
  const base = baseReferences[0]!;
  if (
    JSON.stringify(base.revision) !== sourceRevision ||
    adoptionEvidence.locals.some(({ revision }) => JSON.stringify(revision) !== sourceRevision)
  ) {
    throw new Error("Skill adoption base and target evidence must have equal complete revisions.");
  }
  if (
    metadataEffects.some(
      ({ before, after }) =>
        [before, after].some(
          (use) => use !== undefined && !use.baseUnavailable && use.baseRevisionId !== base.baseRevisionId,
        ) || [before, after].every((use) => use === undefined || use.baseUnavailable),
    )
  ) {
    throw new Error("Skill adoption use effects must reference their shared immutable base.");
  }
  return { metadataEffects, baseReferences, adoptionEvidence };
}
