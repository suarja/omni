import { resolveTarget } from "../../domain/harness-targets";
import type { SkillEffectDraft, SkillStepProgress, SkillEffectOutcome } from "../../application/skill-management";
import type { SkillIssue, SkillEffectStep } from "../../shared/skill-management-ipc";
import type { SkillDetachmentEvidence } from "../../shared/skill-detachment-effects";
import type { SkillDetachmentRequest } from "../../shared/skill-detachment-request";
import type { SkillUseEffect } from "../../domain/skill-reconciliation/types";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { RegistryIpcServices } from "../registry-ipc";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import {
  readSkillDetachmentSnapshot,
  type SkillDetachmentReaderDependencies,
  type SkillDetachmentSnapshot,
} from "./detachment-reader";
import { createSkillDetachmentReceipt } from "./detachment-receipt";

type ReadySnapshot = Extract<SkillDetachmentSnapshot, { status: "ready" }>;

export type SkillDetachmentApplicationDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  bases: SkillBaseStore;
  operationStore: OperationStore;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function locationKey(location: SkillDetachmentEvidence["local"]["location"]): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function targetFolder(binding: import("../../domain/assignment-plan").Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  const artifact = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const id = artifact.split("/").at(-1);
  if (!id) return undefined;
  const resolved = resolveTarget({ kind: "skill", id, harnessId: binding.harnessId });
  return resolved.status === "target" ? resolved.relativePath : undefined;
}

function bindingClaimsLocation(
  binding: import("../../domain/assignment-plan").Binding,
  evidence: SkillDetachmentEvidence,
): boolean {
  const location = evidence.local.location;
  return (
    binding.projectId === location.projectId &&
    binding.harnessId === location.harnessId &&
    targetFolder(binding) === location.folderPath
  );
}

function readerDependencies(args: SkillDetachmentApplicationDependencies): SkillDetachmentReaderDependencies {
  return {
    registry: args.registry,
    relationships: args.relationships,
    bindings: args.bindings,
    bases: args.bases,
    ...(args.filesystem ? { filesystem: args.filesystem } : {}),
    ...(args.now ? { now: args.now } : {}),
  };
}

function requestFor(evidence: SkillDetachmentEvidence): SkillDetachmentRequest {
  return { choice: "detach-managed", skillId: evidence.skillId, locations: [evidence.local.location] };
}

function exactTree(snapshot: ReadySnapshot, evidence: SkillDetachmentEvidence): boolean {
  return (
    snapshot.rootIdentity === evidence.local.rootIdentity &&
    same(snapshot.localTree.revision, evidence.local.revision) &&
    same(snapshot.envelope, evidence.local.envelope) &&
    same(snapshot.record, evidence.record)
  );
}

async function exactBase(bases: SkillBaseStore, evidence: SkillDetachmentEvidence): Promise<boolean> {
  const saved = await bases.read(evidence.base.baseRevisionId);
  return (
    saved.status === "ready" &&
    saved.baseRevisionId === evidence.base.baseRevisionId &&
    same(saved.revision, evidence.base.revision)
  );
}

function beforeStateMatches(snapshot: ReadySnapshot, evidence: SkillDetachmentEvidence): boolean {
  const location = evidence.local.location;
  const uses = snapshot.relationships.uses.filter((use) => locationKey(use.location) === locationKey(location));
  const bindings = snapshot.bindings.filter((binding) => bindingClaimsLocation(binding, evidence));
  return (
    exactTree(snapshot, evidence) &&
    snapshot.relationships.revision === evidence.storeRevision &&
    uses.length === 1 &&
    same(uses[0], evidence.use) &&
    bindings.length === 1 &&
    same(bindings[0], evidence.binding)
  );
}

function afterBindingMatches(snapshot: ReadySnapshot, evidence: SkillDetachmentEvidence): boolean {
  const location = evidence.local.location;
  const uses = snapshot.relationships.uses.filter((use) => locationKey(use.location) === locationKey(location));
  return (
    exactTree(snapshot, evidence) &&
    snapshot.relationships.revision === evidence.storeRevision &&
    uses.length === 1 &&
    same(uses[0], evidence.use) &&
    !snapshot.bindings.some((binding) => bindingClaimsLocation(binding, evidence))
  );
}

function afterUseMatches(snapshot: ReadySnapshot, evidence: SkillDetachmentEvidence): boolean {
  const location = evidence.local.location;
  return (
    exactTree(snapshot, evidence) &&
    snapshot.relationships.skills.some(
      (record) => record.skillId === evidence.skillId && same(record, evidence.record),
    ) &&
    !snapshot.relationships.uses.some((use) => locationKey(use.location) === locationKey(location)) &&
    !snapshot.bindings.some((binding) => bindingClaimsLocation(binding, evidence))
  );
}

function failureOutcome(
  step: SkillEffectStep,
  status: "failed" | "recovery-required",
  message: string,
  recoveryAvailable: boolean,
): SkillEffectOutcome {
  const evidence = step.detachmentEvidence!;
  const binding = evidence.binding;
  const issue: SkillIssue = {
    code: status === "failed" ? "detachment-stale" : "detachment-recovery-required",
    message,
    stepId: step.stepId,
    projectId: evidence.local.location.projectId,
    recoveryAction: "inspect-recovery",
  };
  return {
    status,
    source: { status: "unchanged", sourceId: evidence.use.source.sourceId },
    targets: [
      {
        projectId: binding.projectId,
        harnessId: binding.harnessId,
        bindingId: binding.bindingId,
        artifactPath: binding.artifactPath,
        status: status === "failed" ? "failed" : "unknown",
        issue,
      },
    ],
    receiptIds: [],
    issues: [issue],
    recoveryAvailable,
    detachment: {
      choice: "detach-managed",
      skillId: evidence.skillId,
      location: evidence.local.location,
      source: evidence.use.source,
      bindingId: evidence.binding.bindingId,
      status: status === "failed" ? "failed" : "unknown",
    },
  };
}

async function readFresh(
  request: SkillDetachmentRequest,
  args: SkillDetachmentApplicationDependencies,
): Promise<SkillDetachmentSnapshot> {
  return readSkillDetachmentSnapshot(request, readerDependencies(args));
}

async function writeBindingRemoval(
  args: SkillDetachmentApplicationDependencies,
  evidence: SkillDetachmentEvidence,
): Promise<void> {
  const result = await args.bindings.updateExact([
    { bindingId: evidence.binding.bindingId, expected: evidence.binding },
  ]);
  if (result.status !== "ready") throw new Error("The Binding store could not verify the exact tracking removal.");
  const after = await args.bindings.read();
  if (after.status !== "ready" || after.bindings.some(({ bindingId }) => bindingId === evidence.binding.bindingId))
    throw new Error("The selected Binding removal could not be verified; inspect recovery before continuing.");
}

async function writeUseRemoval(
  args: SkillDetachmentApplicationDependencies,
  evidence: SkillDetachmentEvidence,
): Promise<void> {
  const result = await args.relationships.updateUsesExact(evidence.storeRevision, [
    { skillId: evidence.skillId, location: evidence.local.location, before: evidence.use } satisfies SkillUseEffect,
  ]);
  if (result.status !== "saved") throw new Error("The selected managed-use removal could not be saved exactly.");
}

export async function applySkillDetachment(
  intentId: string,
  effect: SkillEffectDraft,
  progress: SkillStepProgress,
  args: SkillDetachmentApplicationDependencies,
): Promise<SkillEffectOutcome> {
  const step = effect.steps[0];
  const evidence = step?.detachmentEvidence;
  if (
    effect.steps.length !== 1 ||
    !step ||
    !evidence ||
    step.plan.kind !== "detach-skill" ||
    step.plan.actions.length !== 0 ||
    step.files.length !== 0
  ) {
    throw new Error("The approved stop-management effect is invalid.");
  }
  const request = requestFor(evidence);
  const initial = await readFresh(request, args);
  if (initial.status !== "ready" || !beforeStateMatches(initial, evidence) || !(await exactBase(args.bases, evidence)))
    return failureOutcome(
      step,
      "failed",
      "The approved project, copy, Binding, use, or base changed; refresh the preview.",
      false,
    );

  await progress({
    stepId: step.stepId,
    status: "applying",
    managementProgress: { bindings: "pending", uses: "pending" },
  });
  const beforeWrite = await readFresh(request, args);
  if (
    beforeWrite.status !== "ready" ||
    !beforeStateMatches(beforeWrite, evidence) ||
    !(await exactBase(args.bases, evidence))
  )
    return failureOutcome(
      step,
      "failed",
      "The selected copy changed before the first metadata write; refresh the preview.",
      false,
    );

  await writeBindingRemoval(args, evidence);
  await progress({
    stepId: step.stepId,
    status: "applying",
    managementProgress: { bindings: "applied", uses: "pending" },
  });
  const afterBinding = await readFresh(request, args);
  if (
    afterBinding.status !== "ready" ||
    !afterBindingMatches(afterBinding, evidence) ||
    !(await exactBase(args.bases, evidence))
  ) {
    throw new Error("The Binding was removed, but fresh project and relationship checks withheld the use removal.");
  }

  await writeUseRemoval(args, evidence);
  await progress({
    stepId: step.stepId,
    status: "verifying",
    managementProgress: { bindings: "applied", uses: "applied" },
  });
  const afterUse = await readFresh(request, args);
  if (afterUse.status !== "ready" || !afterUseMatches(afterUse, evidence) || !(await exactBase(args.bases, evidence)))
    throw new Error("Both tracking records were changed, but the project, identity, or base no longer verifies.");

  const receipt = createSkillDetachmentReceipt(intentId, step, args.now ?? Date.now);
  const persisted = await args.operationStore.append(receipt);
  if (
    persisted.status !== "ready" ||
    !persisted.receipts.some((saved) => saved.operationId === receipt.operationId && same(saved, receipt))
  ) {
    throw new Error("The stop-management child receipt could not be durably verified; inspect recovery.");
  }

  const binding = evidence.binding;
  return {
    status: "applied",
    source: { status: "unchanged", sourceId: evidence.use.source.sourceId },
    targets: [
      {
        projectId: binding.projectId,
        harnessId: binding.harnessId,
        bindingId: binding.bindingId,
        artifactPath: binding.artifactPath,
        status: "applied",
      },
    ],
    receiptIds: [receipt.operationId],
    receipts: [receipt],
    issues: [],
    recoveryAvailable: false,
    detachment: {
      choice: "detach-managed",
      skillId: evidence.skillId,
      location: evidence.local.location,
      source: evidence.use.source,
      bindingId: binding.bindingId,
      status: "detached",
    },
  };
}
