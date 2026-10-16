import { createHash } from "node:crypto";
import { compareSkillCopyFileBytes } from "../../domain/skill-reconciliation/comparison";

import type { SkillJournalStep, SkillOperationJournalRecord } from "../../application/skill-management-journal";
import type { SkillEffectDraft, SkillEffectBuild } from "../../application/skill-management";
import type { SkillLocationKey, SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import { captureComplete } from "./adoption-reader";
import type { SkillDirectoryEnvelope } from "./unbound-reader";
import { readPreparedUnboundPayload, type PreparedUnboundPayload } from "./unbound-payload";
import { resolveSkillUnboundResolutionReceiptRecord } from "./unbound-receipt";
import { assertSavedPayload, makeInverseActions, readUnboundRecoveryLocalSnapshot } from "./unbound-recovery-plan";

type CompleteTree = NonNullable<Awaited<ReturnType<typeof captureComplete>>>;
export type LocalSnapshot = Readonly<{
  grant: RegistryGrant;
  tree: Extract<CompleteTree, { status: "complete" }>;
  envelope: SkillDirectoryEnvelope;
  rootIdentity: string;
  relationships: Extract<Awaited<ReturnType<SkillRelationshipStore["read"]>>, { status: "ready" }>["state"];
  bindings: Extract<Awaited<ReturnType<BindingsStore["read"]>>, { status: "ready" }>["bindings"];
}>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sourceKey(source: SourceSkillRef): string {
  return JSON.stringify([source.sourceId, source.packageId, source.artifactPath]);
}

function bindingFolder(binding: import("../../domain/assignment-plan").Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  const artifact = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const key = artifact.split("/").at(-1);
  const root = binding.harnessId === "codex" ? ".agents" : binding.harnessId === "claude-code" ? ".claude" : ".cursor";
  return key ? `${root}/skills/${key}` : undefined;
}

function blocked(code: string, message: string): SkillEffectBuild {
  return { status: "blocked", reason: message, details: [{ code, message, recoveryAction: "inspect-recovery" }] };
}

export type UnboundRecoveryDependencies = Readonly<{
  userDataPath: string;
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  bases: SkillBaseStore;
  operationStore: OperationStore;
  journal: import("../../application/skill-management-journal").SkillOperationJournal;
  filesystem: SkillObservationFilesystem;
  now: () => number;
}>;

export type UnboundRecoveryPlan = Readonly<{
  original: SkillOperationJournalRecord;
  sourceStep: SkillEffectStep;
  payload: PreparedUnboundPayload;
  projectGrant: RegistryGrant;
  initial: LocalSnapshot;
  effect: SkillEffectDraft;
  resuming: boolean;
}>;

export async function planUnboundRecovery(
  args: UnboundRecoveryDependencies,
  original: SkillOperationJournalRecord,
  restoreIntentId: string,
): Promise<UnboundRecoveryPlan> {
  if (original.intent.kind !== "reconcile" || original.intent.request.choice !== "link-canonical")
    throw new Error("The saved operation is not an unbound canonical link.");
  const request = original.intent.request;
  const sourceSteps = original.effect?.steps.filter(
    (step) => step.plan.kind === "link-skill" && step.unboundResolutionEvidence,
  );
  if (sourceSteps?.length !== 1) throw new Error("The saved link operation does not have one exact forward effect.");
  const sourceStep = sourceSteps[0]!;
  const evidence = sourceStep.unboundResolutionEvidence!;
  if (
    evidence.skillId !== request.skillId ||
    sourceKey(evidence.source.ref) !== sourceKey(request.source) ||
    locationKey(evidence.local.location) !== locationKey(request.locations[0]!)
  )
    throw new Error("Saved link evidence differs from its exact original request.");
  const payload = await readPreparedUnboundPayload(args.userDataPath, original.intentId);
  if (!payload) throw new Error("The exact before-tree backup and selected-source payload are unavailable.");
  assertSavedPayload(payload, sourceStep);
  const base = sourceStep.baseReferences?.[0];
  const savedBase = base ? await args.bases.read(base.baseRevisionId) : undefined;
  if (!base || savedBase?.status !== "ready" || canonical(savedBase.revision) !== canonical(base.revision))
    throw new Error("The operation-owned selected-source base is unavailable or corrupt.");
  const snapshot = await readUnboundRecoveryLocalSnapshot({
    location: evidence.local.location,
    registry: args.registry,
    relationships: args.relationships,
    bindings: args.bindings,
    filesystem: args.filesystem,
    now: args.now,
  });
  if (snapshot.rootIdentity !== evidence.local.rootIdentity)
    throw new Error("The registered project root changed since the link was reviewed.");
  const currentRecord = snapshot.relationships.skills.find((candidate) => candidate.skillId === evidence.skillId);
  if (canonical(currentRecord) !== canonical(evidence.record))
    throw new Error("The logical skill identity or membership changed since the link.");
  const journalRead = await args.journal.list();
  if (journalRead.status !== "ready")
    throw new Error("The operation journal cannot confirm interrupted inverse progress.");
  const resumeRecord = journalRead.records
    .filter(
      (candidate) =>
        candidate.intent.kind === "restore" &&
        ["applying", "recovery-required"].includes(candidate.status) &&
        candidate.effect?.steps.some(
          (step) =>
            step.unboundResolutionRestoreOrigin?.intentId === original.intentId &&
            step.unboundResolutionRestoreOrigin.stepId === sourceStep.stepId,
        ),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const resumeStep = resumeRecord?.effect?.steps.find(
    (step) =>
      step.unboundResolutionRestoreOrigin?.intentId === original.intentId &&
      step.unboundResolutionRestoreOrigin.stepId === sourceStep.stepId,
  );
  const resumeProgress =
    resumeStep && resumeRecord ? resumeRecord.steps.find((step) => step.stepId === resumeStep.stepId) : undefined;
  const planned = makeInverseActions({
    record: original,
    sourceStep,
    payload,
    snapshot,
    ...(resumeProgress ? { resumeStep: resumeProgress } : {}),
  });
  const expectedUse = sourceStep.metadataEffects?.[0]?.after;
  const expectedBinding = sourceStep.bindingEffects[0]?.after;
  if (!expectedUse || !expectedBinding) throw new Error("The operation-created management records are missing.");
  const actualUse = snapshot.relationships.uses.find(
    (use) => locationKey(use.location) === locationKey(evidence.local.location),
  );
  if (actualUse && canonical(actualUse) !== canonical(expectedUse))
    throw new Error("The selected copy has a later or foreign managed use.");
  if (
    snapshot.relationships.uses.some(
      (use) => use.skillId === evidence.skillId && sourceKey(use.source) !== sourceKey(evidence.source.ref),
    )
  )
    throw new Error("The logical skill now has a conflicting source use.");
  const targetBindings = snapshot.bindings.filter(
    (binding) =>
      binding.projectId === evidence.local.location.projectId &&
      binding.harnessId === evidence.local.location.harnessId &&
      bindingFolder(binding) === evidence.local.location.folderPath,
  );
  if (targetBindings.some((binding) => canonical(binding) !== canonical(expectedBinding)) || targetBindings.length > 1)
    throw new Error("A later or foreign Binding claims the selected copy.");
  const currentBinding = targetBindings[0];
  const baseRef = sourceStep.baseReferences![0]!;
  const bindingEffects = currentBinding ? [{ bindingId: expectedBinding.bindingId, before: expectedBinding }] : [];
  const metadataEffects = actualUse
    ? [{ skillId: evidence.skillId, location: evidence.local.location, before: expectedUse }]
    : [];
  const restoreStepId = createHash("sha256")
    .update(`${restoreIntentId}\nunbound-restore\n${original.intentId}\n${sourceStep.stepId}`)
    .digest("hex")
    .slice(0, 32);
  const stepId = `${restoreStepId.slice(0, 8)}-${restoreStepId.slice(8, 12)}-5${restoreStepId.slice(13, 16)}-8${restoreStepId.slice(17, 20)}-${restoreStepId.slice(20)}`;
  const target = sourceStep.scope.targets[0]!;
  const scope = { ...sourceStep.scope, targets: [{ ...target }] };
  const step: SkillEffectStep = {
    stepId,
    scope,
    plan: {
      planId: stepId,
      kind: "restore-apply",
      displayTarget: sourceStep.plan.displayTarget,
      actions: planned.inverse,
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects,
    files: planned.files.map((file) => {
      const path = file.relativePath.slice(evidence.local.location.folderPath.length + 1);
      const comparison = compareSkillCopyFileBytes(
        { path, change: file.change },
        planned.current.files.get(path),
        payload.beforeFiles.get(path),
      );
      return {
        ...file,
        ...(comparison.diff ? { diff: comparison.diff } : {}),
        ...(comparison.summary ? { summary: comparison.summary } : {}),
      };
    }),
    metadataEffects,
    baseReferences: [baseRef],
    unboundResolutionEvidence: evidence,
    unboundResolutionEnvelope: sourceStep.unboundResolutionEnvelope!,
    unboundResolutionRestoreOrigin: { intentId: original.intentId, stepId: sourceStep.stepId },
  };
  const effect: SkillEffectDraft = {
    status: "ready",
    planId: stepId,
    scope,
    steps: [step],
    fingerprint: {
      scope,
      files: step.files,
      bindings: bindingEffects,
      actions: planned.inverse.map((action) => ({
        rootId: evidence.local.location.projectId,
        kind: action.kind,
        relativePath: action.relativePath,
        ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
        ...(action.afterHash ? { afterHash: action.afterHash } : {}),
      })),
      metadataEffects,
      baseReferences: [baseRef],
      unboundResolutionEvidence: evidence,
      unboundResolutionEnvelope: step.unboundResolutionEnvelope,
      unboundResolutionRestoreOrigin: step.unboundResolutionRestoreOrigin,
    },
    backupReferences: [
      { rootId: evidence.local.location.projectId, path: `skill-unbound-resolutions/${original.intentId}` },
    ],
  };
  const resuming = Boolean(
    resumeProgress && ["applying", "verifying", "applied", "recovery-required"].includes(resumeProgress.status),
  );
  return { original, sourceStep, payload, projectGrant: snapshot.grant, initial: snapshot, effect, resuming };
}
