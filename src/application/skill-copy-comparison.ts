import {
  compareSkillCopyFileBytes,
  chooseSkillCopyFile,
  unionSkillCopyFiles,
} from "../domain/skill-reconciliation/comparison";
import type { SkillCopyFileSummary } from "../domain/skill-reconciliation/comparison";
import type { LogicalSkillRecord, SkillLocationKey, SkillTreeRead } from "../domain/skill-reconciliation/types";
import type { SkillCopyComparisonReader } from "../ports/skill-copy-comparison";
import type { SkillObservationGrant, SkillRelationshipStore } from "../ports/skill-reconciliation";
import type {
  SkillCopyComparisonRequest,
  SkillCopyComparisonResponse,
  SkillCopyLocationReadDto,
} from "../shared/skill-copy-comparison-ipc";

type Dependencies = Readonly<{ store: SkillRelationshipStore; reader: SkillCopyComparisonReader }>;

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function storeSkill(skills: readonly LogicalSkillRecord[], skillId: string): LogicalSkillRecord | undefined {
  return skills.find((skill) => skill.skillId === skillId);
}

function pairBelongsToRecord(record: LogicalSkillRecord | undefined, request: SkillCopyComparisonRequest): boolean {
  if (!record || request.a.projectId !== request.projectId || request.b.projectId !== request.projectId) return false;
  if (locationKey(request.a) === locationKey(request.b)) return false;
  const members = new Set(record.locations.map(locationKey));
  return members.has(locationKey(request.a)) && members.has(locationKey(request.b));
}

function unavailable(
  reason: Extract<SkillCopyComparisonResponse, { status: "unavailable" }>["reason"],
): SkillCopyComparisonResponse {
  return { status: "unavailable", reason };
}

function locationRead(location: SkillLocationKey, read: SkillTreeRead): SkillCopyLocationReadDto {
  return { location, read };
}

function hasExpectedSideFiles(
  file: SkillCopyFileSummary,
  a: ReadonlyMap<string, Uint8Array>,
  b: ReadonlyMap<string, Uint8Array>,
): boolean {
  return (file.left === undefined) === !a.has(file.path) && (file.right === undefined) === !b.has(file.path);
}

export function createSkillCopyComparisonService(dependencies: Dependencies): Readonly<{
  readComparison(
    request: SkillCopyComparisonRequest,
    grant: SkillObservationGrant,
  ): Promise<SkillCopyComparisonResponse>;
}> {
  return {
    async readComparison(request, grant) {
      if (grant.subject.kind !== "project" || grant.subject.id !== request.projectId) return unavailable("grant");
      if (request.a.projectId !== request.projectId || request.b.projectId !== request.projectId) {
        return unavailable("membership");
      }
      const before = await dependencies.store.read();
      if (before.status === "corrupt") return unavailable("store");
      const record = storeSkill(before.state.skills, request.skillId);
      if (!record || !pairBelongsToRecord(record, request)) return unavailable("membership");

      let pair: Awaited<ReturnType<SkillCopyComparisonReader["readPair"]>>;
      try {
        pair = await dependencies.reader.readPair(grant, request.a, request.b);
      } catch {
        return unavailable("read");
      }

      const after = await dependencies.store.read();
      if (after.status === "corrupt") return unavailable("store");
      const currentRecord = storeSkill(after.state.skills, request.skillId);
      if (!currentRecord || !pairBelongsToRecord(currentRecord, request)) return unavailable("membership");
      if (JSON.stringify(record) !== JSON.stringify(currentRecord)) return unavailable("membership");

      const { a: captureA, b: captureB } = pair;
      if (captureA.status !== "complete" || captureB.status !== "complete") {
        return {
          status: "unavailable",
          reason: "read",
          a: locationRead(request.a, captureA),
          b: locationRead(request.b, captureB),
        };
      }

      const aRead = { status: "complete", revision: captureA.revision } as const;
      const bRead = { status: "complete", revision: captureB.revision } as const;
      const files = unionSkillCopyFiles(aRead.revision, bRead.revision);
      if (files.some((file) => !hasExpectedSideFiles(file, captureA.files, captureB.files))) {
        return {
          status: "unavailable",
          reason: "read",
          a: locationRead(request.a, aRead),
          b: locationRead(request.b, bRead),
        };
      }
      const selectedPath = chooseSkillCopyFile(files, request.filePath);
      if (request.filePath !== undefined && selectedPath === undefined) {
        return {
          status: "unavailable",
          reason: "read",
          a: locationRead(request.a, aRead),
          b: locationRead(request.b, bRead),
        };
      }
      if (selectedPath === undefined) {
        return {
          status: "ready",
          projectId: request.projectId,
          skillId: request.skillId,
          a: locationRead(request.a, aRead),
          b: locationRead(request.b, bRead),
          files,
          evidence: { source: "unknown", base: "unknown", relationship: record.evidence },
        };
      }
      const file = files.find((entry) => entry.path === selectedPath);
      if (!file) return unavailable("read");
      const presentation = compareSkillCopyFileBytes(
        file,
        captureA.files.get(selectedPath),
        captureB.files.get(selectedPath),
      );
      return {
        status: "ready",
        projectId: request.projectId,
        skillId: request.skillId,
        a: locationRead(request.a, aRead),
        b: locationRead(request.b, bRead),
        files,
        selectedPath,
        presentation,
        evidence: { source: "unknown", base: "unknown", relationship: record.evidence },
      };
    },
  };
}
