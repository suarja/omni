import type { SkillObservationFilesystem, SkillObservationGrant } from "../../ports/skill-reconciliation";
import type { SkillTreeRead } from "../../domain/skill-reconciliation/types";
import { captureSkillTree, revalidateSkillTree, type SkillScanBudget, type SkillTreeCapture } from "./capture-engine";

export type { SkillScanBudget, SkillTreeCapture } from "./capture-engine";

function isProjectSkillPath(folderPath: string): boolean {
  const parts = folderPath.split("/");
  const root = parts[0];
  return (
    !folderPath.includes("\\") &&
    !folderPath.startsWith("/") &&
    !/^[A-Za-z]:/u.test(folderPath) &&
    parts.length === 3 &&
    (root === ".agents" || root === ".claude" || root === ".cursor") &&
    parts[1] === "skills" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(parts[2] ?? "")
  );
}

function unavailable(): Extract<SkillTreeCapture, { status: "unavailable" }> {
  return { status: "unavailable", reason: "unsafe-tree" };
}

export async function captureCompleteSkillTree(
  grant: SkillObservationGrant,
  folderPath: string,
  budget: SkillScanBudget,
  filesystem: SkillObservationFilesystem,
  digest: (manifest: string) => string,
): Promise<SkillTreeCapture> {
  if (grant.subject.kind !== "project" || !isProjectSkillPath(folderPath)) return unavailable();
  return captureSkillTree(grant, folderPath, budget, filesystem, digest);
}

export async function revalidateSkillTreeCapture(
  capture: Extract<SkillTreeCapture, { status: "complete" }>,
  grant: SkillObservationGrant,
  filesystem: SkillObservationFilesystem,
): Promise<SkillTreeRead> {
  if (grant.subject.kind !== "project" || !isProjectSkillPath(capture.folderPath)) return unavailable();
  return revalidateSkillTree(capture, grant, filesystem);
}
