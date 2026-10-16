import { createHash } from "node:crypto";

import type { SkillCopyCaptureRead, SkillCopyComparisonReader } from "../../ports/skill-copy-comparison";
import type {
  SkillObservationErrorReason,
  SkillObservationFilesystem,
  SkillObservationGrant,
} from "../../ports/skill-reconciliation";
import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import { captureCompleteSkillTree, revalidateSkillTreeCapture, type SkillScanBudget } from "./capture";
import { strictSkillObservationFilesystem } from "./filesystem";

const MAX_SCAN_BYTES = 32 * 1024 * 1024;

type Dependencies = Readonly<{ filesystem?: SkillObservationFilesystem }>;

function expectedFolderRoot(location: SkillLocationKey): string {
  return location.harnessId === "codex"
    ? ".agents/skills/"
    : location.harnessId === "claude-code"
      ? ".claude/skills/"
      : ".cursor/skills/";
}

function validLocation(grant: SkillObservationGrant, location: SkillLocationKey): boolean {
  return (
    location.projectId === grant.subject.id &&
    location.folderPath.startsWith(expectedFolderRoot(location)) &&
    location.folderPath.split("/").length === 3
  );
}

function unavailable(reason: SkillObservationErrorReason): SkillCopyCaptureRead {
  return { status: "unavailable", reason };
}

async function revalidateCapture(
  capture: Awaited<ReturnType<typeof captureCompleteSkillTree>>,
  grant: SkillObservationGrant,
  filesystem: SkillObservationFilesystem,
): Promise<SkillCopyCaptureRead> {
  if (capture.status === "unavailable") return capture;
  const validation = await revalidateSkillTreeCapture(capture, grant, filesystem);
  if (validation.status === "unavailable") return validation;
  return { status: "complete", revision: capture.revision, files: capture.files };
}

export function createSkillCopyComparisonReader(dependencies: Dependencies = {}): SkillCopyComparisonReader {
  const filesystem = dependencies.filesystem ?? strictSkillObservationFilesystem;
  return {
    async readPair(grant, a, b) {
      if (
        grant.subject.kind !== "project" ||
        !validLocation(grant, a) ||
        !validLocation(grant, b) ||
        JSON.stringify(a) === JSON.stringify(b)
      ) {
        const invalid = unavailable("unsafe-tree");
        return { a: invalid, b: invalid };
      }
      const budget: SkillScanBudget = { remainingBytes: MAX_SCAN_BYTES };
      const digest = (manifest: string): string => createHash("sha256").update(manifest, "utf8").digest("hex");
      const capturedA = await captureCompleteSkillTree(grant, a.folderPath, budget, filesystem, digest);
      const capturedB = await captureCompleteSkillTree(grant, b.folderPath, budget, filesystem, digest);
      const [validatedA, validatedB] = await Promise.all([
        revalidateCapture(capturedA, grant, filesystem),
        revalidateCapture(capturedB, grant, filesystem),
      ]);
      return { a: validatedA, b: validatedB };
    },
  };
}
