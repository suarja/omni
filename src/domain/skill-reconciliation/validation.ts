import type { HarnessId } from "../harness-targets";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillDeclaration,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
} from "./types";

type RecordValue = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function text(value: unknown, label: string, max = 240): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function relativePath(value: unknown, label: string): string {
  const path = text(value, label, 1024);
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return path;
}

export function parseSkillRevision(value: unknown): SkillRevision {
  const input = record(value, "Skill revision");
  keys(input, ["algorithm", "hash", "files"], "Skill revision");
  if (input.algorithm !== "omni-tree-v1" || typeof input.hash !== "string" || !HASH.test(input.hash)) {
    throw new Error("Skill revision is invalid.");
  }
  if (!Array.isArray(input.files) || input.files.length > 512) throw new Error("Skill revision file list is invalid.");
  const seen = new Set<string>();
  const files = input.files
    .map((raw): SkillRevision["files"][number] => {
      const file = record(raw, "Skill revision file");
      keys(file, ["path", "hash", "byteLength"], "Skill revision file");
      const path = relativePath(file.path, "Skill revision file path");
      if (seen.has(path)) throw new Error("Skill revision paths must be unique.");
      seen.add(path);
      if (
        typeof file.hash !== "string" ||
        !HASH.test(file.hash) ||
        typeof file.byteLength !== "number" ||
        !Number.isSafeInteger(file.byteLength) ||
        file.byteLength < 0
      ) {
        throw new Error("Skill revision file metadata is invalid.");
      }
      return { path, hash: file.hash, byteLength: file.byteLength };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    files.some((file) => file.byteLength > 1024 * 1024) ||
    files.reduce((total, file) => total + file.byteLength, 0) > 16 * 1024 * 1024
  ) {
    throw new Error("Skill revision exceeds its byte limits.");
  }
  return { algorithm: "omni-tree-v1", hash: input.hash, files };
}

export function parseSkillLocationKey(value: unknown): SkillLocationKey {
  const input = record(value, "Skill location");
  keys(input, ["projectId", "harnessId", "folderPath"], "Skill location");
  const projectId = text(input.projectId, "Project id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(projectId)) throw new Error("Project id is malformed.");
  const harnessId = input.harnessId;
  if (harnessId !== "codex" && harnessId !== "claude-code" && harnessId !== "cursor") {
    throw new Error("Skill harness is invalid.");
  }
  const folderPath = relativePath(input.folderPath, "Skill folder path");
  const root = harnessId === "codex" ? ".agents" : harnessId === "claude-code" ? ".claude" : ".cursor";
  const parts = folderPath.split("/");
  if (
    parts.length !== 3 ||
    parts[0] !== root ||
    parts[1] !== "skills" ||
    (!SEGMENT.test(parts[2] ?? "") && parts[2] !== "__proto__")
  ) {
    throw new Error("Skill folder path is invalid.");
  }
  return { projectId, harnessId: harnessId as HarnessId, folderPath };
}

export function parseSourceSkillRef(value: unknown): SourceSkillRef {
  const input = record(value, "Owned skill source");
  keys(input, ["sourceId", "packageId", "artifactPath"], "Owned skill source");
  const sourceId = text(input.sourceId, "Source id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sourceId)) throw new Error("Source id is malformed.");
  const packageId = relativePath(input.packageId, "Package id");
  const artifactPath = relativePath(input.artifactPath, "Artifact path");
  return { sourceId, packageId, artifactPath };
}

export function parseManagedSkillUse(value: unknown): ManagedSkillUse {
  const input = record(value, "Managed skill use");
  keys(
    input,
    ["skillId", "bindingId", "location", "source", "baseRevisionId", "baseUnavailable", "disabled"],
    "Managed skill use",
  );
  if (input.baseUnavailable !== undefined && input.baseUnavailable !== true)
    throw new Error("Unavailable managed base marker is invalid.");
  if (input.disabled !== undefined && input.disabled !== true)
    throw new Error("Disabled managed use marker is invalid.");
  const skillId = text(input.skillId, "Managed skill id", 64);
  if (!UUID.test(skillId)) throw new Error("Managed skill id must be a UUID.");
  const bindingId = text(input.bindingId, "Binding id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(bindingId)) throw new Error("Binding id is malformed.");
  const baseRevisionId = text(input.baseRevisionId, "Base revision id", 64);
  if (!UUID.test(baseRevisionId)) throw new Error("Base revision id must be a UUID.");
  return {
    skillId,
    bindingId,
    location: parseSkillLocationKey(input.location),
    source: parseSourceSkillRef(input.source),
    baseRevisionId,
    ...(input.baseUnavailable === true ? { baseUnavailable: true as const } : {}),
    ...(input.disabled === true ? { disabled: true as const } : {}),
  };
}

export function parseSkillDeclaration(value: unknown): SkillDeclaration {
  const input = record(value, "Skill declaration");
  keys(input, ["locator", "skillKey", "upstreamPath"], "Skill declaration");
  const locator = text(input.locator, "Skill source locator", 201).toLocaleLowerCase("en-US");
  const locatorParts = locator.split("/");
  if (locatorParts.length !== 2 || locatorParts.some((part) => !SEGMENT.test(part))) {
    throw new Error("Skill source locator is invalid.");
  }
  const skillKey = text(input.skillKey, "Declared skill key", 100);
  if (!SEGMENT.test(skillKey) && skillKey !== "__proto__") {
    throw new Error("Declared skill key is invalid.");
  }
  const upstreamPath =
    input.upstreamPath === undefined ? undefined : relativePath(input.upstreamPath, "Upstream skill path");
  return { locator, skillKey, ...(upstreamPath ? { upstreamPath } : {}) };
}

function locationIdentity(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

export function parseLogicalSkillRecord(value: unknown): LogicalSkillRecord {
  const input = record(value, "Logical skill record");
  keys(input, ["skillId", "label", "evidence", "declaration", "locations", "reference"], "Logical skill record");
  const skillId = text(input.skillId, "Logical skill id", 64);
  if (!UUID.test(skillId)) throw new Error("Logical skill id must be a UUID.");
  const label = text(input.label, "Logical skill label", 100);
  if (input.evidence !== "declared" && input.evidence !== "observed-equivalence" && input.evidence !== "individual") {
    throw new Error("Logical skill evidence is invalid.");
  }
  if (!Array.isArray(input.locations) || input.locations.length < 1 || input.locations.length > 512) {
    throw new Error("Logical skill locations are invalid.");
  }
  const locations = input.locations.map(parseSkillLocationKey);
  if (new Set(locations.map(locationIdentity)).size !== locations.length) {
    throw new Error("Logical skill locations must be unique.");
  }
  return {
    skillId,
    label,
    evidence: input.evidence,
    ...(input.declaration === undefined ? {} : { declaration: parseSkillDeclaration(input.declaration) }),
    locations,
    ...(input.reference === undefined ? {} : { reference: parseSkillRevision(input.reference) }),
  };
}

export function parseSkillRelationshipsState(value: unknown): import("./types").SkillRelationshipsState {
  const input = record(value, "Skill relationship store");
  keys(input, ["schemaVersion", "revision", "skills", "uses"], "Skill relationship store");
  if (
    input.schemaVersion !== 1 ||
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Array.isArray(input.skills) ||
    input.skills.length > 10000
  ) {
    throw new Error("Skill relationship store metadata is invalid.");
  }
  const skills = input.skills.map(parseLogicalSkillRecord);
  const uses = input.uses === undefined ? [] : input.uses;
  if (!Array.isArray(uses) || uses.length > 10000) throw new Error("Managed skill uses are invalid.");
  const managedUses = uses.map(parseManagedSkillUse);
  const ids = new Set(skills.map((skill) => skill.skillId));
  if (ids.size !== skills.length) throw new Error("Logical skill ids must be unique.");
  const locations = new Set<string>();
  for (const skill of skills) {
    for (const location of skill.locations) {
      const identity = locationIdentity(location);
      if (locations.has(identity)) throw new Error("A skill location cannot belong to multiple records.");
      locations.add(identity);
    }
  }
  const skillById = new Map(skills.map((skill) => [skill.skillId, skill]));
  const useLocations = new Set<string>();
  const bindingIds = new Set<string>();
  for (const use of managedUses) {
    const skill = skillById.get(use.skillId);
    if (!skill || !skill.locations.some((location) => locationIdentity(location) === locationIdentity(use.location))) {
      throw new Error("Managed skill use must reference an existing exact location.");
    }
    const key = locationIdentity(use.location);
    if (useLocations.has(key) || bindingIds.has(use.bindingId))
      throw new Error("Managed skill uses must have unique locations and bindings.");
    useLocations.add(key);
    bindingIds.add(use.bindingId);
  }
  return { schemaVersion: 1, revision: input.revision, skills, uses: managedUses };
}
