import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type { SkillLocationKey, SkillUseEffect } from "../../domain/skill-reconciliation/types";
import type { SkillEffectStep, SkillIssue, SkillResult } from "../../shared/skill-management-ipc";
import type { SkillPropagationStepEvidence } from "../../shared/skill-propagation-effects";
import type { OperationReceipt, OperationPlan } from "../../shared/operations-ipc";
import type { SkillPropagationReceiptPointer } from "../../shared/skill-propagation-ipc";
import type { RegistryGrant } from "../registry-ipc";
import { backupFiles, readRegularFile, removeFileOrEmptyDirectories, writeAtomically } from "../operation-files";
import { currentGrantRoot } from "../granted-hashing";
import { captureSkillTree } from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import { freshGrant, observationGrant, skillRootIdentity, SKILL_SCAN_BUDGET_BYTES } from "./adoption-reader";
import { changedFiles, exactRevision, readBackup, revisionMatches } from "./propagation-recovery-files";
import type { PropagationRecoveryDependencies, PropagationRestoreTarget } from "./propagation-recovery-types";

type Dependencies = PropagationRecoveryDependencies;
type RestoreTarget = PropagationRestoreTarget;

const issue = (code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue => ({
  code,
  message,
  recoveryAction,
});
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const locationKey = (location: SkillLocationKey): string =>
  JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function blocked(message: string): SkillEffectBuild {
  return {
    status: "blocked",
    reason: message,
    details: [issue("propagation-restore-blocked", message, "inspect-recovery")],
  };
}

async function inspectRestore(args: Dependencies, receipt: OperationReceipt, intentId: string): Promise<RestoreTarget> {
  const pointer = receipt.skillPropagation;
  if (!pointer || receipt.kind !== "propagate-skill" || receipt.status !== "applied" || receipt.restored)
    throw new Error("The selected propagation receipt is unavailable or already restored.");
  const now = args.now ?? Date.now;
  const grant = await freshGrant(args.registry, { kind: "project", id: pointer.location.projectId }, now);
  if (
    !grant ||
    grant.expiresAt <= now() ||
    !(await currentGrantRoot(grant)) ||
    skillRootIdentity(grant, (value) => createHash("sha256").update(value).digest("hex")) !== pointer.rootIdentity
  )
    throw new Error("Reconnect the exact project root before restoring this propagation.");
  const local = await captureSkillTree(
    observationGrant(grant),
    pointer.location.folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    args.filesystem ?? strictSkillObservationFilesystem,
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  if (local.status !== "complete" || !revisionMatches(local.revision, pointer.afterRevision))
    throw new Error(
      "The propagated project tree changed after the operation; restore is withheld to preserve later edits.",
    );
  const [relationships, bindings, previousBase] = await Promise.all([
    args.relationships.read(),
    args.bindings.read(),
    args.bases.read(pointer.previousUse.baseRevisionId),
  ]);
  if (relationships.status !== "ready" || bindings.status !== "ready" || previousBase.status !== "ready")
    throw new Error("The current relationship, Binding or previous immutable base is unavailable.");
  const use = relationships.state.uses.find((item) => locationKey(item.location) === locationKey(pointer.location));
  const binding = bindings.bindings.find((item) => item.bindingId === pointer.currentBinding.bindingId);
  if (!same(use, pointer.currentUse) || !same(binding, pointer.currentBinding))
    throw new Error("The exact managed-use or Binding metadata changed after propagation.");
  if (!revisionMatches(exactRevision(previousBase.files), previousBase.revision))
    throw new Error("The previous immutable base could not be verified.");
  if (
    pointer.previousUse.baseRevisionId === pointer.currentUse.baseRevisionId &&
    !revisionMatches(previousBase.revision, pointer.beforeRevision)
  )
    throw new Error("The previous base does not match the saved project tree.");
  const filesBefore = await readBackup(args, pointer);
  const sourceGrant = await freshGrant(args.registry, { kind: "source", id: pointer.sourceId }, now);
  if (!sourceGrant || !(await currentGrantRoot(sourceGrant)))
    throw new Error("Reconnect the owned source before restoring propagation metadata.");
  return {
    receipt,
    pointer,
    grant,
    filesBefore,
    filesAfter: local.files,
    relationshipRevision: relationships.state.revision,
    baseRevision: previousBase.revision,
    sourceRootIdentity: skillRootIdentity(sourceGrant, (value) => createHash("sha256").update(value).digest("hex")),
  };
}
function buildRestoreDraft(target: RestoreTarget, intentId: string): SkillEffectDraft {
  const pointer = target.pointer;
  const stepId = randomUUID();
  const changed = changedFiles(pointer.location, target.filesAfter, target.filesBefore);
  const useEffect: SkillUseEffect = {
    skillId: pointer.skillId,
    location: pointer.location,
    before: pointer.currentUse,
    after: pointer.previousUse,
  };
  const nextBase = { baseRevisionId: pointer.previousUse.baseRevisionId, revision: target.baseRevision };
  const source = pointer.currentUse.source;
  const evidence: SkillPropagationStepEvidence = {
    intentId,
    skillId: pointer.skillId,
    source,
    location: pointer.location,
    relationshipRevision: target.relationshipRevision,
    sourceRootIdentity: target.sourceRootIdentity,
    projectRootIdentity: pointer.rootIdentity,
    sourceRevision: target.baseRevision,
    localRevision: pointer.afterRevision,
    baseRevision: pointer.afterRevision,
    previousBaseRevisionId: pointer.currentUse.baseRevisionId,
    nextBaseRevisionId: pointer.previousUse.baseRevisionId,
  };
  const scope = {
    sourceId: pointer.sourceId,
    packageId: source.packageId,
    artifactPath: source.artifactPath,
    targets: [
      {
        projectId: pointer.location.projectId,
        harnessId: pointer.location.harnessId,
        bindingId: pointer.currentBinding.bindingId,
      },
    ],
  };
  const plan: OperationPlan = {
    planId: stepId,
    kind: "propagate-skill",
    displayTarget: pointer.location.folderPath,
    actions: changed.actions,
    git: { mode: "disabled", warnings: [] },
    visibleIn: ["omni"],
  };
  const step: SkillEffectStep = {
    stepId,
    scope,
    plan,
    bindingEffects: [
      { bindingId: pointer.currentBinding.bindingId, before: pointer.currentBinding, after: pointer.previousBinding },
    ],
    files: changed.files,
    metadataEffects: [useEffect],
    baseReferences: [nextBase],
    propagationEvidence: evidence,
  };
  const fingerprint: SkillEffectFingerprint = {
    scope,
    files: step.files,
    bindings: step.bindingEffects,
    actions: plan.actions.map((action) => ({
      rootId: pointer.location.projectId,
      kind: action.kind,
      relativePath: action.relativePath,
      ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
      ...(action.afterHash ? { afterHash: action.afterHash } : {}),
    })),
    metadataEffects: [useEffect],
    baseReferences: [nextBase],
    propagationEvidence: evidence,
  };
  return {
    status: "ready",
    planId: randomUUID(),
    scope,
    steps: [step],
    fingerprint,
    propagation: {
      mode: "maintain-current",
      source,
      targets: [
        {
          skillId: pointer.skillId,
          location: pointer.location,
          bindingId: pointer.currentBinding.bindingId,
          baseRevisionId: pointer.currentUse.baseRevisionId,
          state: "eligible",
          result: "applied",
        },
      ],
    },
    backupReferences: [{ rootId: pointer.location.projectId, path: "backups/skill-propagation-restore/" + intentId }],
  };
}
function receiptForRestore(
  intentId: string,
  step: SkillEffectStep,
  pointer: SkillPropagationReceiptPointer,
  now: () => number,
): OperationReceipt {
  return {
    operationId: randomUUID(),
    kind: "restore-apply",
    status: "applied",
    appliedAt: new Date(now()).toISOString(),
    displayTarget: pointer.location.folderPath,
    actions: step.plan.actions.map((action) => ({ ...action, status: "applied" })),
    git: { mode: "disabled" },
    registered: null,
    source: { kind: "source", id: pointer.sourceId, relativePath: pointer.previousUse.source.artifactPath },
    project: { id: pointer.location.projectId },
    restores: pointer.stepId,
    bindings: [
      { bindingId: pointer.currentBinding.bindingId, before: pointer.currentBinding, after: pointer.previousBinding },
    ],
    diagnostic: "Restored skill propagation operation " + intentId,
  };
}
async function restoreFiles(args: Dependencies, target: RestoreTarget): Promise<void> {
  const folder = target.pointer.location.folderPath;
  for (const path of target.filesAfter.keys())
    if (!target.filesBefore.has(path))
      await removeFileOrEmptyDirectories(target.grant.root, folder + "/" + path, folder);
  for (const [path, bytes] of target.filesBefore) await writeAtomically(target.grant.root, folder + "/" + path, bytes);
  const captured = await captureSkillTree(
    observationGrant(target.grant),
    folder,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    args.filesystem ?? strictSkillObservationFilesystem,
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  if (captured.status !== "complete" || !revisionMatches(captured.revision, target.pointer.beforeRevision))
    throw new Error("The restored project tree failed verification.");
}

async function restoreTreeIfUnchanged(
  args: Dependencies,
  target: RestoreTarget,
  desired: ReadonlyMap<string, Uint8Array>,
  allowed: readonly ReadonlyMap<string, Uint8Array>[],
): Promise<boolean> {
  const filesystem = args.filesystem ?? strictSkillObservationFilesystem;
  const folder = target.pointer.location.folderPath;
  const current = await captureSkillTree(
    observationGrant(target.grant),
    folder,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    filesystem,
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  if (current.status !== "complete") return false;
  const paths = new Set([...current.files.keys(), ...desired.keys(), ...allowed.flatMap((tree) => [...tree.keys()])]);
  for (const path of paths) {
    const currentHash = current.files.has(path) ? sha256(current.files.get(path)!) : undefined;
    if (!allowed.some((tree) => (tree.has(path) ? sha256(tree.get(path)!) : undefined) === currentHash)) return false;
  }
  for (const path of current.files.keys())
    if (!desired.has(path)) await removeFileOrEmptyDirectories(target.grant.root, folder + "/" + path, folder);
  for (const [path, bytes] of desired) {
    const prior = current.files.get(path);
    if (!prior || !Buffer.from(prior).equals(Buffer.from(bytes)))
      await writeAtomically(target.grant.root, folder + "/" + path, bytes);
  }
  const verified = await captureSkillTree(
    observationGrant(target.grant),
    folder,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    filesystem,
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  return verified.status === "complete" && revisionMatches(verified.revision, exactRevision(desired));
}

export function createSkillPropagationRecoveryAdapter(args: Dependencies): Readonly<{
  previewReceipt(receipt: OperationReceipt, intentId: string): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress: SkillStepProgress): Promise<SkillEffectOutcome>;
  has(planId: string): boolean;
}> {
  const plans = new Map<string, RestoreTarget>();
  const drafts = new Map<string, SkillEffectDraft>();
  const previewReceipt = async (receipt: OperationReceipt, intentId: string): Promise<SkillEffectBuild> => {
    try {
      const target = await inspectRestore(args, receipt, intentId);
      const draft = buildRestoreDraft(target, intentId);
      plans.set(draft.planId, target);
      drafts.set(draft.planId, draft);
      return draft;
    } catch (error: unknown) {
      return blocked(error instanceof Error ? error.message : "The propagation restore could not be inspected safely.");
    }
  };
  const prepare = async (intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const target = plans.get(effect.planId);
    if (!target) throw new Error("The propagation restore preview expired.");
    const current = await captureSkillTree(
      observationGrant(target.grant),
      target.pointer.location.folderPath,
      { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
      args.filesystem ?? strictSkillObservationFilesystem,
      (value) => createHash("sha256").update(value).digest("hex"),
    );
    if (current.status !== "complete" || !revisionMatches(current.revision, target.pointer.afterRevision))
      throw new Error("The project changed after restore preview; refresh before applying.");
    const path = join(
      args.userDataPath,
      "omni/backups/skill-propagation-restore",
      intentId,
      target.pointer.location.projectId,
    );
    const folder = target.pointer.location.folderPath;
    for (const file of current.files.keys()) {
      const bytes = await readRegularFile(target.grant.root, folder + "/" + file);
      if (!bytes || sha256(bytes) !== sha256(current.files.get(file)!))
        throw new Error("The current project tree changed during restore backup.");
    }
    await backupFiles(
      target.grant.root,
      path,
      [...current.files.keys()].map((file) => folder + "/" + file),
    );
    for (const [file, bytes] of current.files) {
      const saved = await readRegularFile(path, folder + "/" + file);
      if (!saved || sha256(saved) !== sha256(bytes))
        throw new Error("The verified restore backup is unavailable: " + file);
    }
  };
  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const target = plans.get(effect.planId);
    const step = effect.steps[0];
    if (!target || !step) throw new Error("The propagation restore preview expired.");
    const pointer = target.pointer;
    const now = args.now ?? Date.now;
    await progress({ stepId: step.stepId, status: "applying" });
    let filesRestoreStarted = false;
    let bindingChanged = false;
    let useChanged = false;
    let receiptStored = false;
    try {
      if (
        target.grant.expiresAt <= now() ||
        !(await currentGrantRoot(target.grant)) ||
        skillRootIdentity(target.grant, (value) => createHash("sha256").update(value).digest("hex")) !==
          pointer.rootIdentity
      )
        throw new Error("Reconnect the exact project root before restoring this propagation.");
      const [relationshipsBefore, bindingsBefore] = await Promise.all([
        args.relationships.read(),
        args.bindings.read(),
      ]);
      const exactUse =
        relationshipsBefore.status === "ready"
          ? relationshipsBefore.state.uses.find((use) => locationKey(use.location) === locationKey(pointer.location))
          : undefined;
      const exactBinding =
        bindingsBefore.status === "ready"
          ? bindingsBefore.bindings.find((binding) => binding.bindingId === pointer.currentBinding.bindingId)
          : undefined;
      if (
        relationshipsBefore.status !== "ready" ||
        bindingsBefore.status !== "ready" ||
        !same(exactUse, pointer.currentUse) ||
        !same(exactBinding, pointer.currentBinding)
      )
        throw new Error("The managed-use or Binding changed after restore preview.");
      const current = await captureSkillTree(
        observationGrant(target.grant),
        pointer.location.folderPath,
        { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
        args.filesystem ?? strictSkillObservationFilesystem,
        (value) => createHash("sha256").update(value).digest("hex"),
      );
      if (current.status !== "complete" || !revisionMatches(current.revision, pointer.afterRevision))
        throw new Error("The project changed during restore apply.");
      if (step.plan.actions.length) {
        filesRestoreStarted = true;
        await restoreFiles(args, target);
      }
      const binding = step.bindingEffects[0]!;
      const updatedBinding = await args.bindings.updateExact([
        { bindingId: binding.bindingId, expected: binding.before, next: binding.after },
      ]);
      if (updatedBinding.status !== "ready") throw new Error("The original Binding could not be restored safely.");
      bindingChanged = true;
      const use = step.metadataEffects![0]!;
      const uses = await args.relationships.updateUsesExact(relationshipsBefore.state.revision, [use]);
      if (uses.status !== "saved") throw new Error("The original managed-use base could not be restored safely.");
      useChanged = true;
      const receipt = receiptForRestore(intentId, step, pointer, now);
      const stored = await args.operationStore.append(receipt);
      if (stored.status !== "ready") throw new Error("The propagation restore receipt could not be stored safely.");
      receiptStored = true;
      await args.operationStore.markRestored(pointer.stepId);
      await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId });
      return {
        status: "restored",
        source: { status: "unchanged", sourceId: pointer.sourceId },
        targets: [
          {
            projectId: pointer.location.projectId,
            harnessId: pointer.location.harnessId,
            bindingId: pointer.currentBinding.bindingId,
            artifactPath: pointer.location.folderPath,
            status: "restored",
          },
        ],
        receiptIds: [receipt.operationId],
        receipts: [receipt],
        issues: [],
        recoveryAvailable: false,
      };
    } catch (error: unknown) {
      let rollbackSucceeded = !receiptStored;
      if (!receiptStored && useChanged) {
        const current = await args.relationships.read().catch(() => undefined);
        const saved = step.metadataEffects![0]!;
        const exact =
          current?.status === "ready" &&
          current.state.uses.find((use) => locationKey(use.location) === locationKey(pointer.location));
        if (current?.status === "ready" && exact && same(exact, saved.after)) {
          const reverted = await args.relationships
            .updateUsesExact(current.state.revision, [{ ...saved, before: saved.after, after: saved.before }])
            .catch(() => undefined);
          rollbackSucceeded = Boolean(rollbackSucceeded && reverted?.status === "saved");
        } else rollbackSucceeded = false;
      }
      if (!receiptStored && bindingChanged) {
        const current = await args.bindings.read().catch(() => undefined);
        const change = step.bindingEffects[0]!;
        const exact =
          current?.status === "ready" && current.bindings.find((binding) => binding.bindingId === change.bindingId);
        if (current?.status === "ready" && exact && same(exact, change.after)) {
          const reverted = await args.bindings
            .updateExact([{ bindingId: change.bindingId, expected: change.after, next: change.before }])
            .catch(() => undefined);
          rollbackSucceeded = Boolean(rollbackSucceeded && reverted?.status === "ready");
        } else rollbackSucceeded = false;
      }
      if (!receiptStored && filesRestoreStarted) {
        const restored = await restoreTreeIfUnchanged(args, target, target.filesAfter, [
          target.filesBefore,
          target.filesAfter,
        ]).catch(() => false);
        rollbackSucceeded = Boolean(rollbackSucceeded && restored);
      }
      const recoveryRequired = receiptStored || !rollbackSucceeded;
      await progress({ stepId: step.stepId, status: recoveryRequired ? "recovery-required" : "failed" }).catch(
        () => undefined,
      );
      return {
        status: recoveryRequired ? "recovery-required" : "failed",
        source: { status: "unchanged", sourceId: pointer.sourceId },
        targets: [
          {
            projectId: pointer.location.projectId,
            harnessId: pointer.location.harnessId,
            bindingId: pointer.currentBinding.bindingId,
            artifactPath: pointer.location.folderPath,
            status: recoveryRequired ? "unknown" : "failed",
          },
        ],
        receiptIds: [],
        issues: [
          issue(
            "propagation-restore-failed",
            error instanceof Error ? error.message : "The restore failed safely.",
            "inspect-recovery",
          ),
        ],
        recoveryAvailable: recoveryRequired,
      };
    }
  };
  return { previewReceipt, prepare, apply, has: (planId) => plans.has(planId) };
}
