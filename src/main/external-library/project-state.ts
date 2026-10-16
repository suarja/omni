import { basename } from "node:path";
import { classifyExternalVerification, projectExternalUseState } from "../../domain/external-library";
import type { SkillOriginEvidence } from "../../domain/skill-origins/types";
import type { ProjectSkillRow } from "../../shared/project-skills-ipc";
import { readExternalSnapshot } from "./snapshot";

export function createExternalProjectStateReader(
  options: Readonly<{
    userDataPath?: string;
    projectId: string;
    origins?: readonly SkillOriginEvidence[];
  }>,
): (folderPath: string) => Promise<ProjectSkillRow["state"]> {
  const snapshot = options.userDataPath ? readExternalSnapshot(options.userDataPath) : undefined;
  return async (folderPath) => {
    const origin = options.origins?.find((origin) => origin.relativePath === `${folderPath}/SKILL.md`);
    const source = origin && snapshot?.observations.get(origin.source.locator);
    if (!origin || !source || source.failed) return "unknown";
    const explicit = origin.sourceSkillPath?.replace(/\/SKILL\.md$/u, "");
    const matches = source.skills.filter((skill) => basename(skill.path) === origin.skillKey);
    const observed = snapshot?.sources
      .flatMap((source) => source.uses)
      .find(
        (use) =>
          use.projectId === options.projectId &&
          use.skillKey === origin.skillKey &&
          use.sourceId === origin.source.locator,
      );
    const path =
      explicit ?? (matches.length === 1 ? matches[0]!.path : matches.length === 0 ? observed?.skillPath : undefined);
    if (!path) return "unknown";
    if (origin.verification !== "unverified" && origin.copyHash && origin.copyHash === source.hashes.get(path))
      return "current";
    if (
      origin.verification !== "unverified" &&
      (observed?.lockStale || observed?.state === "unknown") &&
      path === observed.skillPath &&
      origin.copyHash === observed.copyHash &&
      origin.recordedHash === observed.lockHash
    )
      return projectExternalUseState(observed.state);
    return projectExternalUseState(
      classifyExternalVerification({
        lock: origin.recordedHash,
        verification: origin.verification,
        source: source.hashes.get(path),
        removed: source.removed.has(path),
      }).state,
    );
  };
}
