import { randomUUID } from "node:crypto";
import type { ProjectSkillDependencies, ProjectSkillManifest, ProjectSkillPlan } from "./project-skill-plan";
import { createProjectSkillDraft, projectSkillRootIdentity } from "./project-skill-plan";
import { readProjectSkillGrant } from "./project-skills-reader";
import { captureExactSkillTree, hashExactTree } from "./project-skill-files";
import { parkingKey, type ParkingEffect } from "./project-skill-parking";
import type { SkillUseEffect, SkillRecordEffect } from "../../domain/skill-reconciliation/types";
import type { SkillBindingEffect } from "../../shared/skill-management-ipc";

function reverseEffect<T>(
  effect: Readonly<{ before?: T; after?: T }>,
  actual: T | undefined,
): { before?: T; after?: T } | undefined {
  if (JSON.stringify(actual) === JSON.stringify(effect.before)) return undefined;
  if (JSON.stringify(actual) !== JSON.stringify(effect.after))
    throw new Error("Skill metadata changed since the operation; later edits are retained.");
  return { ...(actual ? { before: actual } : {}), ...(effect.before ? { after: effect.before } : {}) };
}

function reverseEffects<T, E extends Readonly<{ before?: T; after?: T }>>(
  effects: readonly E[],
  current: Map<string, T>,
  identify: (effect: E) => string,
): Array<Omit<E, "before" | "after"> & { before?: T; after?: T }> {
  return effects.flatMap((effect) => {
    const key = identify(effect);
    const reverse = reverseEffect(effect, current.get(key));
    if (!reverse) return [];
    if (reverse.after) current.set(key, reverse.after);
    else current.delete(key);
    const { before: _before, after: _after, ...identity } = effect;
    return [{ ...identity, ...reverse }];
  });
}

export async function buildProjectSkillRestore(
  original: ProjectSkillManifest,
  intentId: string,
  args: ProjectSkillDependencies,
): Promise<ProjectSkillPlan> {
  if (original.expiresAt !== undefined && (args.now ?? Date.now)() >= original.expiresAt)
    throw new Error("The project-only skill's 30-day backup has expired.");
  if (original.action === "restore") throw new Error("Restore the original skill operation from its history entry.");
  const relationships = await args.relationships.read();
  const bindings = await args.bindings.read();
  if (relationships.status !== "ready" || bindings.status !== "ready")
    throw new Error("Skill recovery metadata is unavailable.");
  const uses = new Map(relationships.state.uses.map((use) => [parkingKey(use.location), use]));
  const records = new Map(relationships.state.skills.map((record) => [record.skillId, record]));
  const bound = new Map(bindings.bindings.map((binding) => [binding.bindingId, binding]));
  const parked = new Map((await args.parking.read()).map((item) => [parkingKey(item), item]));
  const manifest: ProjectSkillManifest = {
    version: 1,
    intentId,
    row: original.row,
    action: "restore",
    restores: original.intentId,
    steps: [],
    ...(original.expiresAt !== undefined ? { expiresAt: original.expiresAt } : {}),
  };
  for (const saved of [...original.steps].reverse()) {
    if (saved.status === "prepared") continue;
    const grant = await readProjectSkillGrant(saved.location.projectId, args);
    if (projectSkillRootIdentity(grant) !== saved.rootIdentity)
      throw new Error("The project root changed since this skill operation.");
    const step = {
      ...saved,
      stepId: randomUUID(),
      status: "prepared" as const,
      trees: [] as typeof saved.trees,
      parking: [] as ParkingEffect[],
      uses: [] as SkillUseEffect[],
      records: [] as SkillRecordEffect[],
      bindings: [] as SkillBindingEffect[],
      readChecks: [],
    };
    for (const tree of saved.trees) {
      const root = tree.root === "project" ? grant.root : args.userDataPath;
      const current = hashExactTree(await captureExactSkillTree(root, tree.path));
      if (current === tree.beforeHash) continue;
      if (current !== tree.afterHash)
        throw new Error(
          `The skill changed after the operation at ${saved.location.folderPath}; later edits are retained.`,
        );
      if (
        tree.beforeHash &&
        hashExactTree(await captureExactSkillTree(args.userDataPath, tree.beforeBackup!)) !== tree.beforeHash
      )
        throw new Error("The saved exact skill backup is missing or corrupt.");
      step.trees.push({
        root: tree.root,
        path: tree.path,
        ...(tree.afterHash ? { beforeHash: tree.afterHash, beforeBackup: tree.afterBackup } : {}),
        ...(tree.beforeHash ? { afterHash: tree.beforeHash, afterBackup: tree.beforeBackup } : {}),
      });
    }
    step.parking = reverseEffects(saved.parking, parked, (effect) => parkingKey(effect.before ?? effect.after!));
    step.uses = reverseEffects(saved.uses, uses, (effect) => parkingKey(effect.location));
    step.records = reverseEffects(saved.records, records, (effect) => effect.skillId);
    step.bindings = reverseEffects(saved.bindings, bound, (effect) => effect.bindingId);
    if (step.trees.length || step.parking.length || step.uses.length || step.records.length || step.bindings.length)
      manifest.steps.push(step);
  }
  return { manifest, draft: createProjectSkillDraft(manifest), payloads: new Map() };
}
