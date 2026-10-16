import { revisionsEqual } from "./revisions";
import { deriveSkillAttention } from "./attention";
import type {
  SkillCopyLocationRead,
  LogicalSkillRecord,
  ReconciliationState,
  SkillCorrelation,
  SkillCorrelationInput,
  SkillLocationKey,
  SkillMember,
} from "./types";

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function compareLocations(left: SkillLocationKey, right: SkillLocationKey): number {
  return locationKey(left).localeCompare(locationKey(right));
}

function folderKey(member: SkillMember): string {
  return member.location.folderPath.split("/").at(-1) ?? member.location.folderPath;
}

function declarationKey(member: SkillMember): string | undefined {
  const declaration = member.declaration;
  if (!declaration) return undefined;
  const identity = declaration.upstreamPath ?? declaration.skillKey;
  return JSON.stringify([declaration.locator.toLocaleLowerCase("en-US"), identity]);
}

function sameRevisionGroup(members: readonly SkillMember[]): boolean {
  const first = members[0]?.read;
  return Boolean(
    members.length > 1 &&
    first?.status === "complete" &&
    members.every(
      (member) => member.read.status === "complete" && revisionsEqual(first.revision, member.read.revision),
    ),
  );
}

function correlationState(locations: readonly SkillCopyLocationRead[]): ReconciliationState {
  const attention = deriveSkillAttention(locations);
  if (attention.state !== "quiet") return attention.state;
  return locations.length > 1 ? "matching-copies" : "needs-link";
}

function makeUnionFind(length: number): Readonly<{
  find(index: number): number;
  join(left: number, right: number): void;
}> {
  const parents = Array.from({ length }, (_, index) => index);
  const find = (index: number): number => {
    if (parents[index] !== index) parents[index] = find(parents[index]!);
    return parents[index]!;
  };
  const join = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  return { find, join };
}

function joinByKey(
  members: readonly SkillMember[],
  join: (left: number, right: number) => void,
  keyFor: (member: SkillMember) => string | undefined,
): void {
  const firstIndex = new Map<string, number>();
  members.forEach((member, index) => {
    const key = keyFor(member);
    if (!key) return;
    const previous = firstIndex.get(key);
    if (previous === undefined) firstIndex.set(key, index);
    else join(previous, index);
  });
}

function validateInput(input: SkillCorrelationInput): void {
  const seen = new Set<string>();
  for (const member of input.members) {
    if (
      member.location.projectId !== input.projectId ||
      member.ref.entry.kind !== "project" ||
      member.ref.entry.id !== input.projectId ||
      member.ref.kind !== "artifact"
    ) {
      throw new Error("Skill members must belong to the observed project.");
    }
    const key = locationKey(member.location);
    if (seen.has(key)) throw new Error("Skill member locations must be unique.");
    seen.add(key);
  }
  const recordedLocations = new Set<string>();
  for (const record of input.records) {
    for (const location of record.locations) {
      const key = locationKey(location);
      if (recordedLocations.has(key)) throw new Error("Persisted skill locations cannot overlap.");
      recordedLocations.add(key);
    }
  }
  const readLocations = new Map<string, SkillCopyLocationRead>();
  for (const locationRead of input.locationReads ?? []) {
    if (locationRead.location.projectId !== input.projectId) {
      throw new Error("Skill location reads must belong to the observed project.");
    }
    const key = locationKey(locationRead.location);
    if (readLocations.has(key)) throw new Error("Skill location reads must be unique.");
    readLocations.set(key, locationRead);
  }
  for (const member of input.members) {
    const existing = readLocations.get(locationKey(member.location));
    if (existing && JSON.stringify(existing.read) !== JSON.stringify(member.read)) {
      throw new Error("Skill member read must match its location evidence.");
    }
    readLocations.set(locationKey(member.location), { location: member.location, read: member.read });
  }
}

function observedLocationsFor(
  projectId: string,
  record: LogicalSkillRecord,
  members: readonly SkillMember[],
  readByLocation: ReadonlyMap<string, SkillCopyLocationRead>,
): readonly SkillCopyLocationRead[] {
  const locations = new Map<string, SkillCopyLocationRead>();
  for (const member of members) {
    locations.set(locationKey(member.location), { location: member.location, read: member.read });
  }
  for (const location of record.locations.filter((candidate) => candidate.projectId === projectId)) {
    const key = locationKey(location);
    const locationRead = readByLocation.get(key);
    if (!locationRead) throw new Error("Persisted skill location has no fresh observation result.");
    locations.set(key, locationRead);
  }
  return [...locations.values()].sort((left, right) => compareLocations(left.location, right.location));
}

function persistedGroups(
  members: readonly SkillMember[],
  records: readonly LogicalSkillRecord[],
  join: (left: number, right: number) => void,
): void {
  const indexesByRecord = new Map<string, number[]>();
  const indexByLocation = new Map(members.map((member, index) => [locationKey(member.location), index]));
  for (const record of records) {
    for (const location of record.locations) {
      const index = indexByLocation.get(locationKey(location));
      if (index === undefined) continue;
      indexesByRecord.set(record.skillId, [...(indexesByRecord.get(record.skillId) ?? []), index]);
    }
  }
  for (const indexes of indexesByRecord.values()) {
    for (const index of indexes.slice(1)) join(indexes[0]!, index);
  }
}

function groupCandidates(groups: readonly SkillCorrelation["groups"][number][]): SkillCorrelation["candidates"] {
  const candidates: SkillCorrelation["candidates"][number][] = [];
  const seen = new Set<string>();
  for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
    const left = groups[leftIndex]!;
    for (const right of groups.slice(leftIndex + 1)) {
      const leftMember = left.members[0];
      const rightMember = right.members[0];
      if (!leftMember || !rightMember) continue;
      const leftDeclaration = leftMember.declaration;
      const rightDeclaration = rightMember.declaration;
      const sameName = folderKey(leftMember) === folderKey(rightMember);
      const sameContent =
        leftMember.read.status === "complete" &&
        rightMember.read.status === "complete" &&
        revisionsEqual(leftMember.read.revision, rightMember.read.revision);
      const reason =
        leftDeclaration &&
        rightDeclaration &&
        leftDeclaration.locator.toLocaleLowerCase("en-US") !== rightDeclaration.locator.toLocaleLowerCase("en-US")
          ? "conflicting-lineage"
          : sameName
            ? "same-name"
            : sameContent
              ? "same-content"
              : undefined;
      if (!reason) continue;
      const locations = [...left.members, ...right.members].map((member) => member.location).sort(compareLocations);
      const key = JSON.stringify([reason, locations.map(locationKey)]);
      if (!seen.has(key)) (candidates.push({ locations, reason }), seen.add(key));
    }
  }
  return candidates.sort((left, right) =>
    JSON.stringify(left.locations).localeCompare(JSON.stringify(right.locations)),
  );
}

function existingRecordsFor(
  members: readonly SkillMember[],
  records: readonly LogicalSkillRecord[],
): LogicalSkillRecord[] {
  const locations = new Set(members.map((member) => locationKey(member.location)));
  return records.filter((record) => record.locations.some((location) => locations.has(locationKey(location))));
}

function createRecord(
  members: readonly SkillMember[],
  previousRecords: readonly LogicalSkillRecord[],
  allocateId: () => string,
): LogicalSkillRecord {
  const existing = existingRecordsFor(members, previousRecords).sort((left, right) =>
    left.skillId.localeCompare(right.skillId),
  );
  const declaredKey = declarationKey(members[0]!);
  const hasMatchingDeclaration = Boolean(
    declaredKey && members.every((member) => declarationKey(member) === declaredKey),
  );
  const unboundEquivalent =
    members.length > 1 && members.every((member) => !member.declaration) && sameRevisionGroup(members);
  const evidence =
    existing[0]?.evidence ??
    (hasMatchingDeclaration ? "declared" : unboundEquivalent ? "observed-equivalence" : "individual");
  const locations = new Map<string, SkillLocationKey>();
  for (const record of existing)
    for (const location of record.locations) locations.set(locationKey(location), location);
  for (const member of members) locations.set(locationKey(member.location), member.location);
  const firstRevision = members[0]?.read.status === "complete" ? members[0].read.revision : undefined;
  const equalRevisions =
    firstRevision &&
    members.every((member) => member.read.status === "complete" && revisionsEqual(firstRevision, member.read.revision));
  const reference =
    existing.find((record) => record.reference)?.reference ?? (equalRevisions ? firstRevision : undefined);
  const declaration = members.find((member) => member.declaration)?.declaration ?? existing[0]?.declaration;
  return {
    skillId: existing[0]?.skillId ?? allocateId(),
    label: existing[0]?.label ?? folderKey(members[0]!),
    evidence,
    ...(declaration ? { declaration } : {}),
    locations: [...locations.values()].sort(compareLocations),
    ...(reference ? { reference } : {}),
  };
}

export function correlateSkillCopies(input: SkillCorrelationInput): SkillCorrelation {
  validateInput(input);
  const readByLocation = new Map(
    (input.locationReads ?? []).map((locationRead) => [locationKey(locationRead.location), locationRead]),
  );
  for (const member of input.members) {
    readByLocation.set(locationKey(member.location), { location: member.location, read: member.read });
  }
  const members = [...input.members].sort((left, right) => compareLocations(left.location, right.location));
  const union = makeUnionFind(members.length);
  persistedGroups(members, input.records, union.join);
  joinByKey(members, union.join, declarationKey);
  joinByKey(members, union.join, (member) =>
    member.declaration
      ? undefined
      : member.read.status === "complete"
        ? JSON.stringify([folderKey(member), member.read.revision.algorithm, member.read.revision.hash])
        : undefined,
  );

  const indexes = new Map<number, number[]>();
  members.forEach((_member, index) =>
    indexes.set(union.find(index), [...(indexes.get(union.find(index)) ?? []), index]),
  );
  const groups: SkillCorrelation["groups"][number][] = [];
  const records: LogicalSkillRecord[] = [];
  const touchedIds = new Set<string>();
  for (const groupIndexes of indexes.values()) {
    const groupMembers = groupIndexes.map((index) => members[index]!);
    const previous = existingRecordsFor(groupMembers, input.records);
    previous.forEach((record) => touchedIds.add(record.skillId));
    const record = createRecord(groupMembers, input.records, input.allocateId);
    records.push(record);
    const locations = observedLocationsFor(input.projectId, record, groupMembers, readByLocation);
    groups.push({ skillId: record.skillId, members: groupMembers, locations, state: correlationState(locations) });
  }
  const untouched = input.records.filter((record) => !touchedIds.has(record.skillId));
  const nextRecords = [...untouched, ...records].sort((left, right) => left.skillId.localeCompare(right.skillId));
  return {
    records: nextRecords,
    groups: groups.sort((left, right) => {
      const leftLabel = left.members[0] ? folderKey(left.members[0]) : left.skillId;
      const rightLabel = right.members[0] ? folderKey(right.members[0]) : right.skillId;
      return leftLabel.localeCompare(rightLabel) || left.skillId.localeCompare(right.skillId);
    }),
    candidates: groupCandidates(groups),
  };
}
