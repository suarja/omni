import { correlateSkillCopies } from "../domain/skill-reconciliation/correlation";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillCopyLocationRead,
  SkillCorrelation,
  SkillLocationKey,
  SkillMember,
} from "../domain/skill-reconciliation/types";
import type { SkillRelationshipStore } from "../ports/skill-reconciliation";
import type { ObserveSkillCopiesResponse, RetainedSkillCopies } from "../shared/skill-reconciliation-ipc";

const MAX_STORE_ATTEMPTS = 3;

type Dependencies = Readonly<{
  store: SkillRelationshipStore;
  allocateId: () => string;
}>;

type SkillGroup = Readonly<{ groupId: string; members: readonly SkillMember[] }>;

function unavailable(reason: "grant" | "root" | "store" | "observation"): ObserveSkillCopiesResponse {
  return { status: "unavailable", reason };
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function memberReads(groups: readonly SkillGroup[]): SkillCopyLocationRead[] {
  return groups.flatMap(({ members }) => members.map(({ location, read }) => ({ location, read })));
}

function correlateGroups(
  projectId: string,
  groups: readonly SkillGroup[],
  locationReads: readonly SkillCopyLocationRead[],
  records: LogicalSkillRecord[],
  allocateId: () => string,
): Readonly<{
  records: LogicalSkillRecord[];
  groups: readonly Readonly<{ groupId: string; correlation: SkillCorrelation }>[];
}> {
  let nextRecords = records;
  const results = groups.map(({ groupId, members }) => {
    const correlation = correlateSkillCopies({
      projectId,
      members,
      records: nextRecords,
      locationReads,
      allocateId,
    });
    nextRecords = [...correlation.records];
    const activeIds = new Set(correlation.groups.map((group) => group.skillId));
    return {
      groupId,
      correlation: {
        records: correlation.records.filter((record) => activeIds.has(record.skillId)),
        groups: correlation.groups,
        candidates: correlation.candidates,
      },
    };
  });
  return { records: nextRecords, groups: results };
}

function findRetainedSkills(
  projectId: string,
  records: readonly LogicalSkillRecord[],
  activeIds: ReadonlySet<string>,
  reads: readonly SkillCopyLocationRead[],
): readonly RetainedSkillCopies[] | undefined {
  const readByLocation = new Map(reads.map((locationRead) => [locationKey(locationRead.location), locationRead]));
  const retained: RetainedSkillCopies[] = [];
  for (const record of records) {
    const projectLocations = record.locations.filter((location) => location.projectId === projectId);
    if (projectLocations.length === 0 || activeIds.has(record.skillId)) continue;
    const locations = projectLocations.map((location) => readByLocation.get(locationKey(location)));
    if (locations.some((locationRead) => !locationRead)) return undefined;
    retained.push({ record, locations: locations as SkillCopyLocationRead[] });
  }
  return retained.sort((left, right) => left.record.skillId.localeCompare(right.record.skillId));
}

function validateReads(projectId: string, reads: readonly SkillCopyLocationRead[]): boolean {
  const locations = new Set<string>();
  for (const locationRead of reads) {
    const key = locationKey(locationRead.location);
    if (locationRead.location.projectId !== projectId || locations.has(key)) return false;
    locations.add(key);
  }
  return true;
}

function sameRecords(left: readonly LogicalSkillRecord[], right: readonly LogicalSkillRecord[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectUses(projectId: string, uses: readonly ManagedSkillUse[]): readonly ManagedSkillUse[] {
  return uses
    .filter((use) => use.location.projectId === projectId)
    .sort((left, right) => locationKey(left.location).localeCompare(locationKey(right.location)));
}

export function createSkillReconciliationService(dependencies: Dependencies): Readonly<{
  observeProject(
    projectId: string,
    groups: readonly SkillGroup[],
    locationReads?: readonly SkillCopyLocationRead[],
    expectedStoreRevision?: number,
  ): Promise<ObserveSkillCopiesResponse>;
}> {
  return {
    async observeProject(projectId, groups, suppliedReads, expectedStoreRevision) {
      const reads = suppliedReads ?? memberReads(groups);
      if (!validateReads(projectId, reads)) return unavailable("observation");
      for (let attempt = 0; attempt < MAX_STORE_ATTEMPTS; attempt += 1) {
        const loaded = await dependencies.store.read();
        if (loaded.status === "corrupt") return unavailable("store");
        if (expectedStoreRevision !== undefined && loaded.state.revision !== expectedStoreRevision) {
          return unavailable("store");
        }
        const projectRecords = loaded.state.skills.filter((record) =>
          record.locations.some((location) => location.projectId === projectId),
        );
        if (groups.length === 0 && reads.length === 0 && projectRecords.length > 0) {
          return unavailable("observation");
        }
        const correlated = correlateGroups(projectId, groups, reads, [...loaded.state.skills], dependencies.allocateId);
        const activeIds = new Set(
          correlated.groups.flatMap(({ correlation }) => correlation.groups.map((group) => group.skillId)),
        );
        const retained = findRetainedSkills(projectId, correlated.records, activeIds, reads);
        if (!retained) return unavailable("observation");
        if (sameRecords(correlated.records, loaded.state.skills)) {
          return {
            status: "ready",
            groups: correlated.groups,
            retainedSkills: retained,
            managedUses: projectUses(projectId, loaded.state.uses),
            storeRevision: loaded.state.revision,
          };
        }
        const saved = await dependencies.store.compareAndSave(loaded.state.revision, correlated.records);
        if (saved.status === "saved") {
          return {
            status: "ready",
            groups: correlated.groups,
            retainedSkills: retained,
            managedUses: projectUses(projectId, saved.state.uses),
            storeRevision: saved.state.revision,
          };
        }
        if (saved.status === "corrupt" || expectedStoreRevision !== undefined) return unavailable("store");
      }
      return unavailable("store");
    },
  };
}
