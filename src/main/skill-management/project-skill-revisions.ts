import { createHash } from "node:crypto";
import type { ManagedSkillUse, SkillRevision } from "../../domain/skill-reconciliation/types";
import type { ProjectSkillRow } from "../../shared/project-skills-ipc";
import { planSkillPropagationTarget } from "../../domain/skill-reconciliation/propagation";
import type { RegistryGrant } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { captureSkillTree } from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import { observationGrant } from "./adoption-reader";

export async function captureProjectSkillRevision(
  grant: RegistryGrant,
  folderPath: string,
): Promise<SkillRevision | undefined> {
  const tree = await captureSkillTree(
    observationGrant(grant),
    folderPath,
    { remainingBytes: 32 * 1024 * 1024 },
    strictSkillObservationFilesystem,
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  return tree.status === "complete" ? tree.revision : undefined;
}
export async function compareProjectSkillUse(
  use: ManagedSkillUse | undefined,
  grant: RegistryGrant,
  bases: SkillBaseStore,
  sourceRevision: (use: ManagedSkillUse) => Promise<SkillRevision | undefined>,
): Promise<ProjectSkillRow["state"]> {
  if (!use || use.baseUnavailable) return "unknown";
  const base = await bases.read(use.baseRevisionId);
  const local = await captureProjectSkillRevision(grant, use.location.folderPath);
  if (base.status !== "ready" || !local) return "unknown";
  if (local.hash !== base.revision.hash) return "modified-here";
  const comparison = planSkillPropagationTarget({
    source: await sourceRevision(use),
    local,
    base: base.revision,
    safe: true,
    managed: true,
  });
  return comparison === "current" || comparison === "already-current"
    ? "current"
    : comparison === "eligible"
      ? "update-available"
      : "unknown";
}
