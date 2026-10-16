import type {
  LogicalSkillRecord,
  SkillCopyLocationRead,
  SkillCorrelation,
  SkillMember,
  SkillTreeRead,
  ManagedSkillUse,
  SkillManagedAttention,
} from "../domain/skill-reconciliation/types";
import {
  parseLogicalSkillRecord,
  parseManagedSkillUse,
  parseSkillDeclaration,
  parseSkillLocationKey,
  parseSkillRevision,
} from "../domain/skill-reconciliation/validation";
import type { ResourceRef } from "../domain/resource-catalogue";

export const SKILL_RECONCILIATION_IPC_CHANNELS = {
  observe: "omni:skill-reconciliation:observe",
} as const;

export type SkillCopiesMemberRequest = Readonly<{
  ref: Extract<ResourceRef, { kind: "artifact" }>;
  relativePath: string;
}>;
export type SkillCopiesGroupRequest = Readonly<{ groupId: string; members: readonly SkillCopiesMemberRequest[] }>;
export type SkillCopiesGroupResult = Readonly<{ groupId: string; correlation: SkillCorrelation }>;
export type RetainedSkillCopies = Readonly<{
  record: LogicalSkillRecord;
  locations: readonly SkillCopyLocationRead[];
}>;
export type ObserveSkillCopiesRequest = Readonly<{
  projectId: string;
  grantHandle: string;
  groups: readonly SkillCopiesGroupRequest[];
}>;
export type ObserveSkillCopiesResponse =
  | Readonly<{
      status: "ready";
      groups: readonly SkillCopiesGroupResult[];
      retainedSkills: readonly RetainedSkillCopies[];
      managedUses: readonly ManagedSkillUse[];
      managedAttention?: readonly SkillManagedAttention[];
      storeRevision: number;
    }>
  | Readonly<{ status: "unavailable"; reason: "grant" | "root" | "store" | "observation" }>;

export interface SkillReconciliationDesktopApi {
  readWorkspaceSkillUses(): Promise<import("./workspace-skill-uses-ipc").WorkspaceSkillUsesResponse>;
  observeSkillCopies(request: ObserveSkillCopiesRequest): Promise<ObserveSkillCopiesResponse>;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function text(value: unknown, label: string, maximum = 240): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function readPath(value: unknown, label: string): string {
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

function parseArtifactRef(value: unknown, projectId: string): Extract<ResourceRef, { kind: "artifact" }> {
  const input = record(value, "Skill member reference");
  keys(input, ["kind", "entry", "artifactId"], "Skill member reference");
  if (input.kind !== "artifact") throw new Error("Skill member reference kind is invalid.");
  const entry = record(input.entry, "Skill member entry");
  keys(entry, ["kind", "id"], "Skill member entry");
  if (entry.kind !== "project" || entry.id !== projectId)
    throw new Error("Skill member reference is outside the project.");
  return {
    kind: "artifact",
    entry: { kind: "project", id: projectId },
    artifactId: readPath(input.artifactId, "Artifact id"),
  };
}

function parseGroupRequest(value: unknown, projectId: string): SkillCopiesGroupRequest {
  const input = record(value, "Skill group request");
  keys(input, ["groupId", "members"], "Skill group request");
  const groupId = text(input.groupId, "Skill group id", 512);
  if (!Array.isArray(input.members) || input.members.length > 512) throw new Error("Skill group members are invalid.");
  const members = input.members.map((raw): SkillCopiesMemberRequest => {
    const member = record(raw, "Skill member request");
    keys(member, ["ref", "relativePath"], "Skill member request");
    const relativePath = readPath(member.relativePath, "Skill member path");
    if (!/^(\.agents|\.claude|\.cursor)\/skills\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/SKILL\.md$/u.test(relativePath)) {
      throw new Error("Skill member path must be a conventional skill location.");
    }
    return { ref: parseArtifactRef(member.ref, projectId), relativePath };
  });
  const locationKeys = members.map((member) => JSON.stringify([member.ref.artifactId, member.relativePath]));
  if (new Set(locationKeys).size !== locationKeys.length) throw new Error("Skill group members must be unique.");
  return { groupId, members };
}

export function parseObserveSkillCopiesRequest(value: unknown): ObserveSkillCopiesRequest {
  const input = record(value, "Skill observation request");
  keys(input, ["projectId", "grantHandle", "groups"], "Skill observation request");
  const projectId = text(input.projectId, "Project id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(projectId)) throw new Error("Project id is malformed.");
  const grantHandle = text(input.grantHandle, "Grant handle", 256);
  if (grantHandle.includes("/") || grantHandle.includes("\\") || grantHandle.includes("..")) {
    throw new Error("Grant handle must be opaque.");
  }
  if (!Array.isArray(input.groups) || input.groups.length > 128) throw new Error("Skill groups are invalid.");
  const groups = input.groups.map((group) => parseGroupRequest(group, projectId));
  if (new Set(groups.map((group) => group.groupId)).size !== groups.length)
    throw new Error("Skill group ids must be unique.");
  const totalMembers = groups.reduce((total, group) => total + group.members.length, 0);
  if (totalMembers > 1024) throw new Error("Skill observation exceeds its member limit.");
  const memberPaths = groups.flatMap((group) => group.members.map((member) => member.relativePath));
  if (new Set(memberPaths).size !== memberPaths.length) {
    throw new Error("Skill observation locations must be unique across groups.");
  }
  return { projectId, grantHandle, groups };
}

function parseTreeRead(value: unknown): SkillTreeRead {
  const input = record(value, "Skill tree read");
  if (input.status === "complete") {
    keys(input, ["status", "revision"], "Skill tree read");
    return { status: "complete", revision: parseSkillRevision(input.revision) };
  }
  keys(input, ["status", "reason"], "Skill tree read");
  if (
    input.status !== "unavailable" ||
    !["missing", "denied", "unsafe-tree", "limit", "changed-during-read", "io"].includes(String(input.reason))
  ) {
    throw new Error("Skill tree read status is invalid.");
  }
  return { status: "unavailable", reason: input.reason as Extract<SkillTreeRead, { status: "unavailable" }>["reason"] };
}

function parseMember(value: unknown): SkillMember {
  const input = record(value, "Skill member");
  keys(input, ["location", "ref", "read", "declaration"], "Skill member");
  const location = parseSkillLocationKey(input.location);
  const ref = parseArtifactRef(input.ref, location.projectId);
  if (ref.entry.id !== location.projectId) throw new Error("Skill member project is invalid.");
  return {
    location,
    ref,
    read: parseTreeRead(input.read),
    ...(input.declaration === undefined ? {} : { declaration: parseSkillDeclaration(input.declaration) }),
  };
}

function parseLocationRead(value: unknown): SkillCopyLocationRead {
  const input = record(value, "Skill location read");
  keys(input, ["location", "read"], "Skill location read");
  return { location: parseSkillLocationKey(input.location), read: parseTreeRead(input.read) };
}

function sameLocation(left: SkillCopyLocationRead["location"], right: SkillCopyLocationRead["location"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateLocationReads(
  locations: readonly SkillCopyLocationRead[],
  recordValue: LogicalSkillRecord,
  members: readonly SkillMember[] = [],
): void {
  if (locations.length === 0) throw new Error("Skill location reads are invalid.");
  const locationKeys = new Set<string>();
  const projectId = locations[0]!.location.projectId;
  for (const locationRead of locations) {
    const key = JSON.stringify(locationRead.location);
    if (locationRead.location.projectId !== projectId || locationKeys.has(key)) {
      throw new Error("Skill location reads must be unique within one project.");
    }
    if (!recordValue.locations.some((location) => sameLocation(location, locationRead.location))) {
      throw new Error("Skill location read is outside its logical record.");
    }
    locationKeys.add(key);
  }
  const recordProjectLocations = recordValue.locations.filter((location) => location.projectId === projectId);
  if (recordProjectLocations.length !== locations.length) {
    throw new Error("Skill location reads must cover every known project location.");
  }
  for (const member of members) {
    const matching = locations.find((locationRead) => sameLocation(locationRead.location, member.location));
    if (!matching || JSON.stringify(matching.read) !== JSON.stringify(member.read)) {
      throw new Error("Skill member read does not match its location evidence.");
    }
  }
}

function parseCorrelation(value: unknown): SkillCorrelation {
  const input = record(value, "Skill correlation");
  keys(input, ["records", "groups", "candidates"], "Skill correlation");
  if (
    !Array.isArray(input.records) ||
    !Array.isArray(input.groups) ||
    input.groups.length > 1024 ||
    !Array.isArray(input.candidates) ||
    input.candidates.length > 10000
  ) {
    throw new Error("Skill correlation lists are invalid.");
  }
  const records = input.records.map(parseLogicalSkillRecord);
  const recordIds = new Set(records.map((skill) => skill.skillId));
  const groups = input.groups.map((raw): SkillCorrelation["groups"][number] => {
    const group = record(raw, "Skill correlation group");
    keys(group, ["skillId", "members", "locations", "state"], "Skill correlation group");
    if (
      typeof group.skillId !== "string" ||
      !recordIds.has(group.skillId) ||
      !Array.isArray(group.members) ||
      group.members.length === 0
    ) {
      throw new Error("Skill correlation group is invalid.");
    }
    if (
      ![
        "matching-copies",
        "copy-difference",
        "update-available",
        "local-change",
        "conflict",
        "needs-link",
        "unavailable",
      ].includes(String(group.state))
    ) {
      throw new Error("Skill correlation state is invalid.");
    }
    const members = group.members.map(parseMember);
    const relationship = records.find((skill) => skill.skillId === group.skillId);
    if (
      !relationship ||
      members.some(
        (member) =>
          !relationship.locations.some((location) => JSON.stringify(location) === JSON.stringify(member.location)),
      )
    ) {
      throw new Error("Skill correlation membership is inconsistent.");
    }
    const locations = Array.isArray(group.locations) ? group.locations.map(parseLocationRead) : [];
    validateLocationReads(locations, relationship, members);
    return {
      skillId: group.skillId,
      members,
      locations,
      state: group.state as SkillCorrelation["groups"][number]["state"],
    };
  });
  const candidates = input.candidates.map((raw): SkillCorrelation["candidates"][number] => {
    const candidate = record(raw, "Skill candidate");
    keys(candidate, ["locations", "reason"], "Skill candidate");
    if (
      !Array.isArray(candidate.locations) ||
      !["same-name", "same-content", "conflicting-lineage"].includes(String(candidate.reason))
    ) {
      throw new Error("Skill candidate is invalid.");
    }
    return {
      locations: candidate.locations.map(parseSkillLocationKey),
      reason: candidate.reason as SkillCorrelation["candidates"][number]["reason"],
    };
  });
  const locations = new Set(groups.flatMap((group) => group.members.map((member) => JSON.stringify(member.location))));
  if (locations.size !== groups.reduce((total, group) => total + group.members.length, 0)) {
    throw new Error("Skill correlation members overlap.");
  }
  return { records, groups, candidates };
}

export function parseObserveSkillCopiesResponse(value: unknown): ObserveSkillCopiesResponse {
  const input = record(value, "Skill observation response");
  if (input.status === "unavailable") {
    keys(input, ["status", "reason"], "Skill observation response");
    if (!["grant", "root", "store", "observation"].includes(String(input.reason)))
      throw new Error("Skill observation failure is invalid.");
    return {
      status: "unavailable",
      reason: input.reason as Extract<ObserveSkillCopiesResponse, { status: "unavailable" }>["reason"],
    };
  }
  keys(
    input,
    ["status", "groups", "retainedSkills", "managedUses", "managedAttention", "storeRevision"],
    "Skill observation response",
  );
  if (
    input.status !== "ready" ||
    !Array.isArray(input.groups) ||
    !Array.isArray(input.retainedSkills) ||
    input.retainedSkills.length > 1024 ||
    !Array.isArray(input.managedUses) ||
    input.managedUses.length > 1024 ||
    (input.managedAttention !== undefined &&
      (!Array.isArray(input.managedAttention) || input.managedAttention.length > 1024)) ||
    typeof input.storeRevision !== "number" ||
    !Number.isSafeInteger(input.storeRevision) ||
    input.storeRevision < 0
  ) {
    throw new Error("Skill observation response is invalid.");
  }
  const groups = input.groups.map((raw): SkillCopiesGroupResult => {
    const group = record(raw, "Skill observation group");
    keys(group, ["groupId", "correlation"], "Skill observation group");
    return { groupId: text(group.groupId, "Skill group id", 512), correlation: parseCorrelation(group.correlation) };
  });
  const retainedSkills = input.retainedSkills.map((raw): RetainedSkillCopies => {
    const retained = record(raw, "Retained logical skill");
    keys(retained, ["record", "locations"], "Retained logical skill");
    const relationship = parseLogicalSkillRecord(retained.record);
    if (!Array.isArray(retained.locations) || retained.locations.length > 512) {
      throw new Error("Retained skill locations are invalid.");
    }
    const locations = retained.locations.map(parseLocationRead);
    validateLocationReads(locations, relationship);
    return { record: relationship, locations };
  });
  const managedUses = input.managedUses.map(parseManagedSkillUse);
  const managedAttention = (input.managedAttention ?? []).map((raw): SkillManagedAttention => {
    const item = record(raw, "Managed skill attention");
    keys(item, ["skillId", "location", "state"], "Managed skill attention");
    const skillId = text(item.skillId, "Managed attention skill id", 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(skillId))
      throw new Error("Managed attention skill id is invalid.");
    if (!["matches-base", "local-change", "unavailable"].includes(String(item.state)))
      throw new Error("Managed skill attention state is invalid.");
    return {
      skillId,
      location: parseSkillLocationKey(item.location),
      state: item.state as SkillManagedAttention["state"],
    };
  });
  if (new Set(managedAttention.map((item) => JSON.stringify(item.location))).size !== managedAttention.length)
    throw new Error("Managed skill attention locations must be unique.");
  const recordEvidence = new Map<string, string>();
  for (const skill of groups.flatMap((group) => group.correlation.records)) {
    const evidence = JSON.stringify(skill);
    const previous = recordEvidence.get(skill.skillId);
    if (previous !== undefined && previous !== evidence)
      throw new Error("Shared logical skills must return consistent identity evidence.");
    recordEvidence.set(skill.skillId, evidence);
  }
  const recordsById = new Map(
    [...groups.flatMap((group) => group.correlation.records), ...retainedSkills.map(({ record }) => record)].map(
      (skill) => [skill.skillId, skill] as const,
    ),
  );
  const useLocations = new Set<string>();
  const bindingIds = new Set<string>();
  for (const use of managedUses) {
    const skill = recordsById.get(use.skillId);
    if (!skill || !skill.locations.some((location) => sameLocation(location, use.location))) {
      throw new Error("Managed skill use must reference a returned exact location.");
    }
    const locationKey = JSON.stringify(use.location);
    if (useLocations.has(locationKey) || bindingIds.has(use.bindingId)) {
      throw new Error("Managed skill uses must have unique locations and bindings.");
    }
    useLocations.add(locationKey);
    bindingIds.add(use.bindingId);
  }
  if (input.managedAttention !== undefined) {
    if (managedAttention.length !== managedUses.length)
      throw new Error("Managed skill attention must describe every current managed use.");
    for (const attention of managedAttention) {
      const use = managedUses.find((candidate) => sameLocation(candidate.location, attention.location));
      if (!use || use.skillId !== attention.skillId)
        throw new Error("Managed skill attention must reference one exact current use.");
    }
  }
  const skillIds = new Set<string>();
  const locationKeys = new Set<string>();
  const memberKeys = new Set<string>();
  const readEvidence = new Map<string, string>();
  for (const result of groups) {
    const ids = result.correlation.groups.map((group) => group.skillId);
    if (new Set(ids).size !== ids.length) throw new Error("Logical skills must be unique within one source group.");
    for (const group of result.correlation.groups) {
      skillIds.add(group.skillId);
      for (const member of group.members) {
        const key = JSON.stringify(member.location);
        if (memberKeys.has(key)) throw new Error("Observed skill members cannot overlap.");
        memberKeys.add(key);
      }
      // A managed and an observed copy can share one identity across presentation groups.
      for (const location of group.locations) {
        const key = JSON.stringify(location.location);
        const evidence = JSON.stringify([group.skillId, location.read]);
        const previous = readEvidence.get(key);
        if (previous !== undefined && previous !== evidence)
          throw new Error("Shared skill locations must return consistent read evidence.");
        readEvidence.set(key, evidence);
        locationKeys.add(key);
      }
    }
  }
  for (const retained of retainedSkills) {
    if (skillIds.has(retained.record.skillId))
      throw new Error("Retained logical skills cannot overlap observed groups.");
    skillIds.add(retained.record.skillId);
    for (const location of retained.locations) {
      const key = JSON.stringify(location.location);
      if (locationKeys.has(key)) throw new Error("Retained skill locations cannot overlap observed groups.");
      locationKeys.add(key);
    }
  }
  return { status: "ready", groups, retainedSkills, managedUses, managedAttention, storeRevision: input.storeRevision };
}
