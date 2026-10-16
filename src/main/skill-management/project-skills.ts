import { createProjectSkillAssignmentCompletion } from "./project-skill-assignment";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillOperationJournal } from "../../application/skill-management-journal";
import type { SkillIntent } from "../../shared/skill-management-ipc";
import type { ProjectSkillIntent, ProjectSkills } from "../../shared/project-skills-ipc";
import type { OperationStore } from "../operation-store";
import { createProjectSkillParking } from "./project-skill-parking";
import {
  buildProjectSkillPlan,
  blockProjectSkill,
  projectSkillManifestPath,
  type ProjectSkillDependencies,
  type ProjectSkillPlan,
} from "./project-skill-plan";
import { buildProjectSkillRestore } from "./project-skill-restore";
import { readProjectSkills } from "./project-skills-reader";
import { readProjectSkillManifest } from "./project-skill-manifest";
import { applyProjectSkillManifest } from "./project-skill-apply";
import {
  captureExactSkillTree,
  guardSkillPath,
  hashExactTree,
  hashProjectSkillValue,
  materializeExactSkillTree,
  pathExists,
  writeProjectSkillJson,
} from "./project-skill-files";
import { recordParentRestored } from "./restore-parent";
import { validateProjectSkillFileInputs, validateProjectSkillLifetime } from "./project-skill-validation";
import { purgeOrphanedProjectSkillParking } from "./project-skill-parking-cleanup";

type ProjectSkillsAdapterInput = Omit<ProjectSkillDependencies, "parking"> &
  Readonly<{ operationStore: OperationStore; journal: SkillOperationJournal }>;

async function purgeExpiredProjectSkillBackups(args: ProjectSkillDependencies): Promise<void> {
  const directory = await guardSkillPath(args.userDataPath, "omni/backups/project-skills");
  if (!(await pathExists(directory))) return;
  for (const id of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}$/u.test(id)) continue;
    const manifest = await readProjectSkillManifest(args.userDataPath, id);
    if (manifest?.expiresAt !== undefined && (args.now ?? Date.now)() >= manifest.expiresAt)
      await rm(join(directory, id), { recursive: true });
  }
}

async function readReviewedProjectSkillRestore(
  operationId: string,
  intentId: string,
  input: ProjectSkillsAdapterInput,
  args: ProjectSkillDependencies,
): Promise<ProjectSkillPlan | undefined> {
  const journal = await input.journal.read(operationId);
  if (journal.status !== "ready" || journal.record.intent.kind !== "project-skill") return undefined;
  if (
    !journal.record.effect?.steps.some((step) => step.projectSkillEvidence) &&
    journal.record.intent.action === "install-agent"
  )
    return undefined;
  if (journal.record.result?.status === "restored")
    throw new Error("This project skill operation has already been restored.");
  const original = await readProjectSkillManifest(args.userDataPath, operationId);
  if (!original) throw new Error("The project skill backup is unavailable or its 30-day retention has expired.");
  const reviewed = journal.record.effect?.steps[0]?.projectSkillEvidence;
  const normalized = { ...original, steps: original.steps.map((step) => ({ ...step, status: "prepared" })) };
  if (original.steps.length && (!reviewed || reviewed.manifestHash !== hashProjectSkillValue(normalized)))
    throw new Error("The project skill recovery manifest no longer matches its reviewed journal evidence.");
  return buildProjectSkillRestore(original, intentId, args);
}

function requireProjectSkillPlan(
  intentId: string,
  effect: SkillEffectDraft,
  plans: ReadonlyMap<string, ProjectSkillPlan>,
): ProjectSkillPlan {
  const plan = plans.get(effect.planId);
  if (!plan || plan.manifest.intentId !== intentId) throw new Error("The project skill preview expired; refresh it.");
  return plan;
}

async function prepareProjectSkillPlan(
  intentId: string,
  plan: ProjectSkillPlan,
  args: ProjectSkillDependencies,
): Promise<void> {
  validateProjectSkillLifetime(plan.manifest, args);
  for (const step of plan.manifest.steps) await validateProjectSkillFileInputs(step, args);
  for (const [path, tree] of plan.payloads) {
    await materializeExactSkillTree(args.userDataPath, path, tree);
    if (hashExactTree(await captureExactSkillTree(args.userDataPath, path)) !== hashExactTree(tree))
      throw new Error("The exact project skill backup did not verify.");
  }
  await writeProjectSkillJson(args.userDataPath, projectSkillManifestPath(intentId), plan.manifest);
}

async function applyProjectSkillPlan(
  plan: ProjectSkillPlan,
  args: ProjectSkillDependencies,
  input: ProjectSkillsAdapterInput,
  progress: SkillStepProgress,
): Promise<SkillEffectOutcome> {
  validateProjectSkillLifetime(plan.manifest, args);
  const outcome = await applyProjectSkillManifest(plan.manifest, args, progress);
  if (outcome.status === "restored" && plan.manifest.restores)
    await recordParentRestored(input.operationStore, input.journal, plan.manifest.restores);
  return outcome;
}

export function createProjectSkillsAdapter(input: ProjectSkillsAdapterInput): Readonly<{
  assignmentBindingIds(
    result: import("../../shared/skill-management-ipc").SkillResult,
  ): Promise<readonly string[] | undefined>;
  recordAssignmentBridge(
    result: import("../../shared/skill-management-ipc").SkillResult,
  ): Promise<import("../../shared/skill-management-ipc").SkillResult>;
  reconcileAssignmentBridges(): Promise<void>;
  readProjectSkills(projectId: string): Promise<ProjectSkills>;
  preview(intent: ProjectSkillIntent, intentId: string): Promise<SkillEffectBuild>;
  previewRestore(operationId: string, intentId: string): Promise<SkillEffectBuild | undefined>;
  assignmentFor(intent: ProjectSkillIntent): Promise<Extract<SkillIntent, { kind: "assign" }> | undefined>;
  has(planId: string): boolean;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  purgeExpired(): Promise<void>;
  cleanupParking(): Promise<void>;
}> {
  const args: ProjectSkillDependencies = { ...input, parking: createProjectSkillParking(input.userDataPath) };
  const plans = new Map<string, ProjectSkillPlan>();
  const purgeExpired = (): Promise<void> => purgeExpiredProjectSkillBackups(args);
  const preview = async (intent: ProjectSkillIntent, intentId: string): Promise<SkillEffectBuild> => {
    try {
      await purgeExpired();
      const plan = await buildProjectSkillPlan(intent, intentId, args);
      plans.set(plan.draft.planId, plan);
      return plan.draft;
    } catch (error) {
      return blockProjectSkill(
        error instanceof Error ? error.message : "The project skill cannot be previewed safely.",
      );
    }
  };
  const previewRestore = async (operationId: string, intentId: string): Promise<SkillEffectBuild | undefined> => {
    try {
      const plan = await readReviewedProjectSkillRestore(operationId, intentId, input, args);
      if (!plan) return undefined;
      plans.set(plan.draft.planId, plan);
      return plan.draft;
    } catch (error) {
      return blockProjectSkill(error instanceof Error ? error.message : "Project skill recovery is unavailable.");
    }
  };
  const assignmentFor = async (
    intent: ProjectSkillIntent,
  ): Promise<Extract<SkillIntent, { kind: "assign" }> | undefined> => {
    if (intent.action !== "install-agent") return undefined;
    const view = await readProjectSkills(intent.projectId, args);
    const row = view.skills.find((row) => row.id === intent.rowId);
    if (!row) throw new Error("The logical project skill is unavailable.");
    const agent = row.agents[intent.harnessIds![0]!];
    if (
      agent.state !== "absent" ||
      !row.skillId ||
      row.origin.kind === "project-only" ||
      !row.origin.sourceId ||
      !row.origin.packageId ||
      !row.origin.artifactPath
    )
      return undefined;
    return {
      kind: "assign",
      sourceId: row.origin.sourceId,
      packageId: row.origin.packageId,
      artifactPath: row.origin.artifactPath,
      targets: [{ projectId: intent.projectId, harnessIds: intent.harnessIds! }],
    };
  };
  return {
    ...createProjectSkillAssignmentCompletion(input),
    readProjectSkills: async (projectId) => {
      await purgeExpired();
      return readProjectSkills(projectId, args);
    },
    preview,
    previewRestore,
    assignmentFor,
    has: (planId) => plans.has(planId),
    prepare: (intentId, effect) =>
      prepareProjectSkillPlan(intentId, requireProjectSkillPlan(intentId, effect, plans), args),
    apply: (intentId, effect, progress) =>
      applyProjectSkillPlan(requireProjectSkillPlan(intentId, effect, plans), args, input, progress),
    purgeExpired,
    cleanupParking: () => purgeOrphanedProjectSkillParking({ ...input, parking: args.parking }),
  };
}
