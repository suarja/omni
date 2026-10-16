import type { ProjectSkillDependencies, ProjectSkillManifest, ProjectSkillSavedStep } from "./project-skill-plan";
import { projectSkillRootIdentity } from "./project-skill-plan";
import { readProjectSkillGrant } from "./project-skills-reader";
import { captureExactSkillTree, hashExactTree } from "./project-skill-files";
import type { RegistryGrant } from "../registry-ipc";

export function validateProjectSkillLifetime(manifest: ProjectSkillManifest, args: ProjectSkillDependencies): void {
  if (
    manifest.action === "restore" &&
    manifest.expiresAt !== undefined &&
    (args.now ?? Date.now)() >= manifest.expiresAt
  )
    throw new Error("The project-only skill's 30-day backup has expired.");
}

export async function validateProjectSkillFileInputs(
  step: ProjectSkillSavedStep,
  args: ProjectSkillDependencies,
): Promise<RegistryGrant> {
  const grant = await readProjectSkillGrant(step.location.projectId, args);
  if (projectSkillRootIdentity(grant) !== step.rootIdentity)
    throw new Error("The granted project root changed; reopen it.");
  for (const check of step.readChecks ?? []) {
    if (hashExactTree(await captureExactSkillTree(grant.root, check.folderPath)) !== check.hash)
      throw new Error("The peer skill changed after preview; refresh its installation.");
  }
  for (const tree of step.trees) {
    const root = tree.root === "project" ? grant.root : args.userDataPath;
    if (hashExactTree(await captureExactSkillTree(root, tree.path)) !== tree.beforeHash)
      throw new Error(`The skill location changed after preview: ${step.location.folderPath}`);
  }
  return grant;
}
