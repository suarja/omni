import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { SkillEffectBuild, SkillEffectDraft } from "../../application/skill-management";
import type {
  SkillUseEffect,
  SkillRecordEffect,
  SkillLocationKey,
  ManagedSkillUse,
  LogicalSkillRecord,
} from "../../domain/skill-reconciliation/types";
import type { ProjectSkillIntent, ProjectSkillRow } from "../../shared/project-skills-ipc";
import type { Binding } from "../../domain/assignment-plan";
import { readProjectSkillTransition, type ProjectSkillTransition } from "./project-skill-transition";
import type { SkillBindingEffect, SkillEffectStep } from "../../shared/skill-management-ipc";
import type { RegistryGrant } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import { skillRootIdentity } from "./adoption-reader";
import {
  captureExactSkillTree,
  hashExactTree,
  hashProjectSkillValue,
  type ExactSkillTree,
} from "./project-skill-files";
import type { ParkingEffect } from "./project-skill-parking";
import {
  readProjectSkillGrant,
  readProjectSkills,
  type ProjectSkillsReaderDependencies,
} from "./project-skills-reader";

export type ProjectSkillDependencies = ProjectSkillsReaderDependencies &
  Readonly<{ userDataPath: string; bindings: BindingsStore }>;
export type TreeEffect = Readonly<{
  root: "project" | "omni";
  path: string;
  beforeHash?: string;
  afterHash?: string;
  beforeBackup?: string;
  afterBackup?: string;
}>;
export type ProjectSkillSavedStep = {
  stepId: string;
  location: SkillLocationKey;
  rootIdentity: string;
  trees: TreeEffect[];
  parking: ParkingEffect[];
  uses: SkillUseEffect[];
  records: SkillRecordEffect[];
  bindings: SkillBindingEffect[];
  status: "prepared" | "applying" | "applied";
  readChecks?: readonly Readonly<{ folderPath: string; hash: string }>[];
};
export type ProjectSkillManifest = {
  version: 1;
  intentId: string;
  row: ProjectSkillRow;
  action: ProjectSkillIntent["action"] | "restore";
  steps: ProjectSkillSavedStep[];
  expiresAt?: number;
  restores?: string;
};
export type ProjectSkillPlan = Readonly<{
  manifest: ProjectSkillManifest;
  draft: SkillEffectDraft;
  payloads: ReadonlyMap<string, ExactSkillTree>;
}>;

export function blockProjectSkill(message: string): SkillEffectBuild {
  return {
    status: "blocked",
    reason: message,
    details: [{ code: "project-skill-unavailable", message, recoveryAction: "inspect-recovery" }],
  };
}
export function projectSkillManifestPath(intentId: string): string {
  return `omni/backups/project-skills/${intentId}/manifest.json`;
}
export function projectSkillRootIdentity(grant: RegistryGrant): string {
  return skillRootIdentity(grant, hashProjectSkillValue);
}

export function createProjectSkillDraft(manifest: ProjectSkillManifest): SkillEffectDraft {
  const scope = {
    targets: manifest.steps.map((step) => ({
      projectId: step.location.projectId,
      harnessId: step.location.harnessId,
      ...(step.uses[0]?.before?.bindingId ? { bindingId: step.uses[0].before.bindingId } : {}),
    })),
  };
  const evidence = {
    projectId: manifest.steps[0]?.location.projectId ?? "unknown",
    rowId: manifest.row.id,
    action: manifest.action,
    origin: manifest.row.origin.kind,
    manifestHash: hashProjectSkillValue(manifest),
  };
  const steps: SkillEffectStep[] = manifest.steps.map((step) => {
    const files = step.trees
      .filter((tree) => tree.root === "project")
      .map((tree) => ({
        rootId: step.location.projectId,
        relativePath: tree.path,
        change: tree.afterHash ? (tree.beforeHash ? ("change" as const) : ("add" as const)) : ("delete" as const),
        ...(tree.beforeHash ? { beforeHash: tree.beforeHash } : {}),
        ...(tree.afterHash ? { afterHash: tree.afterHash } : {}),
      }));
    return {
      stepId: step.stepId,
      scope: { targets: scope.targets.filter((target) => target.harnessId === step.location.harnessId) },
      plan: {
        planId: step.stepId,
        kind:
          manifest.action === "restore"
            ? "restore-apply"
            : manifest.action === "install-agent"
              ? "write-skill"
              : "remove-binding",
        displayTarget: `${manifest.action} · ${manifest.row.name}`,
        actions: files.map((file) => ({
          kind: file.change === "delete" ? ("delete-directory" as const) : ("write-file" as const),
          relativePath: file.relativePath,
          ...(file.beforeHash ? { beforeHash: file.beforeHash } : {}),
          ...(file.afterHash ? { afterHash: file.afterHash } : {}),
        })),
        git: { mode: "unavailable", warnings: [] },
      },
      files,
      bindingEffects: step.bindings,
      metadataEffects: step.uses,
      projectSkillEvidence: evidence,
    };
  });
  return {
    status: "ready",
    planId: manifest.intentId,
    scope,
    steps,
    fingerprint: {
      scope,
      files: steps.flatMap((step) => step.files),
      bindings: steps.flatMap((step) => step.bindingEffects),
      metadataEffects: steps.flatMap((step) => step.metadataEffects ?? []),
      projectSkillEvidence: evidence,
    },
    backupReferences: [
      { rootId: evidence.projectId, path: projectSkillManifestPath(manifest.intentId).replace(/^omni\//u, "") },
    ],
  };
}

function sameLocation(left: SkillLocationKey, right: SkillLocationKey): boolean {
  return left.projectId === right.projectId && left.folderPath === right.folderPath;
}

function appendTree(
  step: ProjectSkillSavedStep,
  intentId: string,
  payloads: Map<string, ExactSkillTree>,
  root: TreeEffect["root"],
  path: string,
  before: ExactSkillTree | undefined,
  after: ExactSkillTree | undefined,
): void {
  if (hashExactTree(before) === hashExactTree(after)) return;
  const prefix = `omni/backups/project-skills/${intentId}/${step.stepId}/${step.trees.length}`;
  const beforeBackup = before && `${prefix}/before`;
  const afterBackup = after && `${prefix}/after`;
  if (beforeBackup) payloads.set(beforeBackup, before!);
  if (afterBackup) payloads.set(afterBackup, after!);
  step.trees.push({
    root,
    path,
    ...(before ? { beforeHash: hashExactTree(before), beforeBackup } : {}),
    ...(after ? { afterHash: hashExactTree(after), afterBackup } : {}),
  });
}
function appendTransitionTrees(
  step: ProjectSkillSavedStep,
  transition: ProjectSkillTransition,
  intentId: string,
  payloads: Map<string, ExactSkillTree>,
): void {
  const { location, local, nextLocal, park, nextPark, parkedTree, nextParkTree } = transition;
  appendTree(step, intentId, payloads, "project", location.folderPath, local, nextLocal);
  if (park) appendTree(step, intentId, payloads, "omni", park.contentPath, parkedTree, nextParkTree);
  else if (nextPark) appendTree(step, intentId, payloads, "omni", nextPark.contentPath, undefined, nextParkTree);
  if (park || nextPark)
    step.parking.push({ ...(park ? { before: park } : {}), ...(nextPark ? { after: nextPark } : {}) });
}
function appendProjectSkillMetadata(
  step: ProjectSkillSavedStep,
  action: ProjectSkillIntent["action"],
  uses: readonly ManagedSkillUse[],
  bindings: readonly Binding[],
  records: Map<string, LogicalSkillRecord>,
): void {
  const use = uses.find((use) => sameLocation(use.location, step.location));
  if (use) {
    const { disabled: _disabled, ...enabled } = use;
    step.uses.push({
      skillId: use.skillId,
      location: step.location,
      before: use,
      ...(action === "delete"
        ? {}
        : { after: action === "disable" || action === "remove-agent" ? { ...use, disabled: true } : enabled }),
    });
    if (action === "delete") {
      const binding = bindings.find((binding) => binding.bindingId === use.bindingId);
      if (binding) step.bindings.push({ bindingId: binding.bindingId, before: binding });
    }
  }
  if (action !== "delete") return;
  const record = [...records.values()].find((record) =>
    record.locations.some((location) => sameLocation(location, step.location)),
  );
  if (!record) return;
  const locations = record.locations.filter((location) => !sameLocation(location, step.location));
  const next = locations.length ? { ...record, locations } : undefined;
  step.records.push({ skillId: record.skillId, before: record, ...(next ? { after: next } : {}) });
  if (next) records.set(record.skillId, next);
  else records.delete(record.skillId);
}

async function preserveDependentAgents(
  step: ProjectSkillSavedStep,
  transition: ProjectSkillTransition,
  row: ProjectSkillRow,
  grant: RegistryGrant,
  intentId: string,
  payloads: Map<string, ExactSkillTree>,
  selected: readonly string[],
): Promise<void> {
  if (!transition.local || transition.local[0]?.kind === "symlink" || transition.nextLocal) return;
  const removedRoot = resolve(grant.root, transition.location.folderPath);
  for (const [harness, agent] of Object.entries(row.agents)) {
    if (selected.includes(harness) || agent.state !== "installed" || !agent.folderPath) continue;
    const before = await captureExactSkillTree(grant.root, agent.folderPath);
    if (before?.[0]?.kind !== "symlink") continue;
    const target = await realpath(join(grant.root, agent.folderPath));
    if (target !== removedRoot && !target.startsWith(`${removedRoot}/`)) continue;
    const after = await captureExactSkillTree(grant.root, relative(grant.root, target));
    if (!after) throw new Error("The other agent's linked skill cannot be preserved. Refresh before removal.");
    // A peer link must stay readable after its target is parked for the selected agent.
    appendTree(step, intentId, payloads, "project", agent.folderPath, before, after);
  }
}

export async function buildProjectSkillPlan(
  intent: ProjectSkillIntent,
  intentId: string,
  args: ProjectSkillDependencies,
): Promise<ProjectSkillPlan> {
  const view = await readProjectSkills(intent.projectId, args);
  const row = view.skills.find((row) => row.id === intent.rowId);
  if (!row) throw new Error("The logical project skill is unavailable; refresh the project.");
  if (
    intent.action === "remove-agent" &&
    Object.values(row.agents).filter((agent) => agent.state === "installed").length <= 1
  )
    intent = { ...intent, action: "disable" };
  const grant = await readProjectSkillGrant(intent.projectId, args);
  const parked = await args.parking.read();
  const relationships = await args.relationships.read();
  const bindings = await args.bindings.read();
  if (relationships.status !== "ready" || bindings.status !== "ready")
    throw new Error("Project skill management stores are unavailable.");
  const records = new Map(relationships.state.skills.map((record) => [record.skillId, record]));
  const payloads = new Map<string, ExactSkillTree>();
  const steps: ProjectSkillSavedStep[] = [];
  const selected = intent.harnessIds ?? ["claude-code", "codex"];
  for (const harnessId of selected) {
    const transition = await readProjectSkillTransition(
      intent,
      row,
      harnessId,
      grant,
      parked,
      args,
      (location) =>
        relationships.state.uses.some((use) => sameLocation(use.location, location)) ||
        [...records.values()].some((record) => record.locations.some((item) => sameLocation(item, location))),
    );
    if (!transition) continue;
    const { location, readChecks } = transition;
    const step: ProjectSkillSavedStep = {
      stepId: randomUUID(),
      location,
      rootIdentity: projectSkillRootIdentity(grant),
      trees: [],
      parking: [],
      uses: [],
      records: [],
      bindings: [],
      status: "prepared",
      ...(readChecks?.length ? { readChecks } : {}),
    };
    appendTransitionTrees(step, transition, intentId, payloads);
    if (intent.action === "remove-agent" || intent.action === "disable")
      await preserveDependentAgents(step, transition, row, grant, intentId, payloads, selected);
    appendProjectSkillMetadata(step, intent.action, relationships.state.uses, bindings.bindings, records);
    steps.push(step);
  }
  const manifest: ProjectSkillManifest = {
    version: 1,
    intentId,
    row,
    action: intent.action,
    steps,
    ...(intent.action === "delete" && row.origin.kind === "project-only"
      ? { expiresAt: (args.now ?? Date.now)() + 30 * 24 * 60 * 60 * 1000 }
      : {}),
  };
  return { manifest, draft: createProjectSkillDraft(manifest), payloads };
}
