import type { SkillObservationFilesystem, SkillObservationGrant } from "../../ports/skill-reconciliation";
import type { SkillTreeRead } from "../../domain/skill-reconciliation/types";
import { captureCompleteSkillTree, type SkillScanBudget } from "./capture";

export type { SkillScanBudget } from "./capture";

export async function observeCompleteSkillTree(
  grant: SkillObservationGrant,
  folderPath: string,
  budget: SkillScanBudget,
  filesystem: SkillObservationFilesystem,
  digest: (manifest: string) => string,
): Promise<SkillTreeRead> {
  const capture = await captureCompleteSkillTree(grant, folderPath, budget, filesystem, digest);
  if (capture.status === "unavailable") return capture;
  return { status: "complete", revision: capture.revision };
}
