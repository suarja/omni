import type { SkillEffectOutcome, SkillStepProgress } from "../../application/skill-management";
import type { SkillResult } from "../../shared/skill-management-ipc";
import type { ProjectSkillManifest, ProjectSkillDependencies, ProjectSkillSavedStep } from "./project-skill-plan";
import { projectSkillManifestPath } from "./project-skill-plan";
import type { RegistryGrant } from "../registry-ipc";
import {
  captureExactSkillTree,
  hashExactTree,
  materializeExactSkillTree,
  removeExactSkillTree,
  writeProjectSkillJson,
} from "./project-skill-files";
import { parkingKey } from "./project-skill-parking";
import { validateProjectSkillFileInputs } from "./project-skill-validation";

async function verifyProjectSkillMetadata(
  step: ProjectSkillSavedStep,
  args: ProjectSkillDependencies,
): Promise<number> {
  const parked = await args.parking.read();
  for (const effect of step.parking) {
    const ref = effect.before ?? effect.after!;
    if (JSON.stringify(parked.find((item) => parkingKey(item) === parkingKey(ref))) !== JSON.stringify(effect.before))
      throw new Error("Parked skill metadata changed after preview.");
  }
  const relationships = await args.relationships.read();
  const bindings = await args.bindings.read();
  if (relationships.status !== "ready" || bindings.status !== "ready")
    throw new Error("Skill management metadata is unavailable.");
  for (const effect of step.uses) {
    const actual = relationships.state.uses.find(
      (use) =>
        use.location.projectId === effect.location.projectId && use.location.folderPath === effect.location.folderPath,
    );
    if (JSON.stringify(actual) !== JSON.stringify(effect.before))
      throw new Error("The managed use changed after preview.");
  }
  for (const effect of step.records) {
    if (
      JSON.stringify(relationships.state.skills.find((skill) => skill.skillId === effect.skillId)) !==
      JSON.stringify(effect.before)
    )
      throw new Error("The logical skill changed after preview.");
  }
  for (const effect of step.bindings) {
    if (
      JSON.stringify(bindings.bindings.find((binding) => binding.bindingId === effect.bindingId)) !==
      JSON.stringify(effect.before)
    )
      throw new Error("The skill Binding changed after preview.");
  }
  return relationships.state.revision;
}

async function applyProjectSkillTrees(
  step: ProjectSkillSavedStep,
  args: ProjectSkillDependencies,
  grant: RegistryGrant,
): Promise<void> {
  // Write the exact recoverable copy before removing the original project or parked copy.
  for (const tree of [...step.trees].sort(
    (left, right) => Number(Boolean(right.afterHash)) - Number(Boolean(left.afterHash)),
  )) {
    const root = tree.root === "project" ? grant.root : args.userDataPath;
    if (tree.beforeHash) await removeExactSkillTree(root, tree.path, tree.beforeHash);
    if (tree.afterHash) {
      const saved = await captureExactSkillTree(args.userDataPath, tree.afterBackup!);
      if (hashExactTree(saved) !== tree.afterHash) throw new Error("The exact skill backup no longer verifies.");
      await materializeExactSkillTree(root, tree.path, saved!);
    }
  }
}

async function applyProjectSkillMetadata(
  step: ProjectSkillSavedStep,
  args: ProjectSkillDependencies,
  revision: number,
): Promise<void> {
  if (step.bindings.length) {
    const updated = await args.bindings.updateExact(
      step.bindings.map((effect) => ({ bindingId: effect.bindingId, expected: effect.before, next: effect.after })),
    );
    if (updated.status !== "ready") throw new Error("The skill Bindings could not be updated exactly.");
  }
  if (step.uses.length || step.records.length) {
    const updated = await args.relationships.updateUsesExact(revision, step.uses, step.records);
    if (updated.status !== "saved") throw new Error("The managed skill metadata could not be updated exactly.");
  }
  if (step.parking.length) await args.parking.update(step.parking);
}

function targetOutcome(
  step: ProjectSkillSavedStep,
  status: SkillResult["targets"][number]["status"],
): SkillResult["targets"][number] {
  return {
    projectId: step.location.projectId,
    harnessId: step.location.harnessId,
    bindingId: step.uses[0]?.before?.bindingId ?? step.stepId,
    artifactPath: step.location.folderPath,
    status,
  };
}

export async function applyProjectSkillManifest(
  manifest: ProjectSkillManifest,
  args: ProjectSkillDependencies,
  progress: SkillStepProgress,
): Promise<SkillEffectOutcome> {
  const targets: SkillResult["targets"][number][] = [];
  const issues: SkillResult["issues"][number][] = [];
  let started = false;
  for (const [index, step] of manifest.steps.entries()) {
    try {
      const grant = await validateProjectSkillFileInputs(step, args);
      const revision = await verifyProjectSkillMetadata(step, args);
      step.status = "applying";
      await writeProjectSkillJson(args.userDataPath, projectSkillManifestPath(manifest.intentId), manifest);
      await progress({ stepId: step.stepId, status: "applying" });
      started = true;
      await applyProjectSkillTrees(step, args, grant);
      await applyProjectSkillMetadata(step, args, revision);
      step.status = "applied";
      await writeProjectSkillJson(args.userDataPath, projectSkillManifestPath(manifest.intentId), manifest);
      await progress({ stepId: step.stepId, status: "applied" });
      targets.push(
        targetOutcome(
          step,
          manifest.action === "restore"
            ? "restored"
            : manifest.action === "delete" || manifest.action === "disable"
              ? "removed"
              : "applied",
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project skill effect failed safely.";
      issues.push({
        code: "project-skill-effect-failed",
        message,
        projectId: step.location.projectId,
        relativePath: step.location.folderPath,
        recoveryAction: started ? "inspect-recovery" : "refresh",
      });
      await progress({ stepId: step.stepId, status: "failed" });
      targets.push(targetOutcome(step, step.status === "applying" ? "unknown" : "failed"));
      for (const skipped of manifest.steps.slice(index + 1)) {
        await progress({ stepId: skipped.stepId, status: "skipped" });
        targets.push(targetOutcome(skipped, "skipped"));
      }
      return {
        status: started ? "recovery-required" : "failed",
        source: { status: "unchanged" },
        targets,
        receiptIds: [],
        issues,
        recoveryAvailable: started,
      };
    }
  }
  return {
    status: !manifest.steps.length ? "no-op" : manifest.action === "restore" ? "restored" : "applied",
    source: { status: "unchanged" },
    targets,
    receiptIds: [],
    issues,
    recoveryAvailable: false,
  };
}
