import { createHash } from "node:crypto";

import type { SkillStepProgress } from "../../application/skill-management";
import type { SkillEffectStep, SkillIssue } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { SkillPropagationTarget } from "../../shared/skill-propagation-ipc";
import type { RegistryGrant } from "../registry-ipc";
import { readRegularFile, removeFileOrEmptyDirectories, writeAtomically } from "../operation-files";
import { currentGrantRoot } from "../granted-hashing";
import { captureSkillTree } from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import {
  freshGrant,
  hasActiveSourceAndProject,
  observationGrant,
  skillRootIdentity,
  SKILL_SCAN_BUDGET_BYTES,
} from "./adoption-reader";
import type { ReadySkillPropagationSnapshot, SkillPropagationDependencies } from "./propagation-types";

const issue = (code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue => ({
  code,
  message,
  recoveryAction,
});
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const locationKey = (location: SkillLocationKey): string =>
  JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
const backupRelativePath = (intentId: string, bindingId: string): string =>
  "omni/backups/skill-propagation/" + intentId + "/" + bindingId;
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function hashOrAbsent(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? sha256(bytes) : undefined;
}
function errorIssue(error: unknown, code: string): SkillIssue {
  return issue(
    code,
    error instanceof Error ? error.message : "The target could not be updated safely.",
    "inspect-recovery",
  );
}
function targetUse(step: SkillEffectStep) {
  const effect = step.metadataEffects?.[0];
  if (!effect?.before || !effect.after || !step.propagationEvidence)
    throw new Error("Saved propagation metadata is incomplete.");
  return effect;
}

async function validateTarget(
  args: SkillPropagationDependencies,
  snapshot: ReadySkillPropagationSnapshot,
  target: ReadySkillPropagationSnapshot["locations"][number],
): Promise<Readonly<{ grant: RegistryGrant; relationshipRevision: number }>> {
  const now = args.now ?? Date.now;
  const sourceGrant = await freshGrant(args.registry, { kind: "source", id: snapshot.intent.source.sourceId }, now);
  const projectGrant = await freshGrant(args.registry, { kind: "project", id: target.location.projectId }, now);
  if (
    !sourceGrant ||
    !projectGrant ||
    projectGrant.expiresAt <= now() ||
    !(await currentGrantRoot(projectGrant)) ||
    !(await currentGrantRoot(sourceGrant))
  )
    throw new Error("Reconnect the owned source and selected project before applying this target.");
  if (
    target.rootIdentity &&
    skillRootIdentity(projectGrant, (value) => createHash("sha256").update(value).digest("hex")) !== target.rootIdentity
  )
    throw new Error("The selected project root changed after the propagation preview.");
  const registry = await args.registry.listRegistry();
  if (!hasActiveSourceAndProject(registry, snapshot.intent.source.sourceId, target.location.projectId))
    throw new Error("The source or selected project is no longer active.");
  const filesystem = args.filesystem ?? strictSkillObservationFilesystem;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const sourceTree = await captureSkillTree(
    observationGrant(sourceGrant),
    snapshot.sourceFolderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    filesystem,
    digest,
  );
  if (sourceTree.status !== "complete" || sourceTree.revision.hash !== snapshot.projectedSource.revision.hash)
    throw new Error("The owned source changed after the propagation preview.");
  if (!target.localTree || !target.use || !target.binding || !target.baseRevisionId || !target.baseTree)
    throw new Error("The target no longer has complete managed-copy evidence.");
  const localTree = await captureSkillTree(
    observationGrant(projectGrant),
    target.location.folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    filesystem,
    digest,
  );
  if (localTree.status !== "complete" || localTree.revision.hash !== target.localTree.revision.hash)
    throw new Error("The project copy changed after the propagation preview.");
  const [relationships, bindings, base] = await Promise.all([
    args.relationships.read(),
    args.bindings.read(),
    args.bases.read(target.baseRevisionId),
  ]);
  if (relationships.status !== "ready" || bindings.status !== "ready" || base.status !== "ready")
    throw new Error("The relationship, Binding or immutable base is unavailable.");
  const use = relationships.state.uses.find((item) => locationKey(item.location) === locationKey(target.location));
  const binding = bindings.bindings.find((item) => item.bindingId === target.binding!.bindingId);
  if (!same(use, target.use) || !same(binding, target.binding) || base.revision.hash !== target.baseTree.revision.hash)
    throw new Error("The exact managed use, Binding or immutable base changed after preview.");
  return { grant: projectGrant, relationshipRevision: relationships.state.revision };
}

async function applyFiles(
  args: SkillPropagationDependencies,
  grant: RegistryGrant,
  step: import("../../shared/skill-management-ipc").SkillEffectStep,
  target: ReadySkillPropagationSnapshot["locations"][number],
  onReplaced: () => void,
): Promise<void> {
  const evidence = step.propagationEvidence!;
  const beforeFiles = target.localTree!.files;
  const base = await args.bases.read(step.baseReferences![0]!.baseRevisionId);
  if (base.status !== "ready" || base.revision.hash !== evidence.sourceRevision.hash)
    throw new Error("The published propagation base could not be reopened.");
  for (const [path, before] of beforeFiles) {
    const current = await readRegularFile(grant.root, target.location.folderPath + "/" + path);
    if (hashOrAbsent(current) !== sha256(before))
      throw new Error("A project file changed during propagation apply: " + path);
  }
  for (const [path, next] of base.files) {
    const before = beforeFiles.get(path);
    if (!before || !Buffer.from(before).equals(Buffer.from(next)))
      await writeAtomically(grant.root, target.location.folderPath + "/" + path, next, undefined, onReplaced);
  }
  for (const path of beforeFiles.keys())
    if (!base.files.has(path)) {
      await removeFileOrEmptyDirectories(
        grant.root,
        target.location.folderPath + "/" + path,
        target.location.folderPath,
      );
      onReplaced();
    }
  const verified = await captureSkillTree(
    observationGrant(grant),
    target.location.folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    args.filesystem ?? strictSkillObservationFilesystem,
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  if (verified.status !== "complete" || verified.revision.hash !== evidence.sourceRevision.hash)
    throw new Error("The propagated project tree did not verify against the approved source revision.");
}

async function rollbackFiles(
  args: SkillPropagationDependencies,
  grant: RegistryGrant,
  target: ReadySkillPropagationSnapshot["locations"][number],
  projected: ReadonlyMap<string, Uint8Array>,
): Promise<boolean> {
  if (!target.localTree) return false;
  try {
    const filesystem = args.filesystem ?? strictSkillObservationFilesystem;
    const current = await captureSkillTree(
      observationGrant(grant),
      target.location.folderPath,
      { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
      filesystem,
      (value) => createHash("sha256").update(value).digest("hex"),
    );
    if (current.status !== "complete") return false;
    const before = target.localTree.files;
    const paths = new Set([...current.files.keys(), ...before.keys(), ...projected.keys()]);
    for (const path of paths) {
      const currentHash = hashOrAbsent(current.files.get(path));
      const beforeHash = hashOrAbsent(before.get(path));
      const afterHash = hashOrAbsent(projected.get(path));
      if (currentHash !== beforeHash && currentHash !== afterHash) return false;
    }
    for (const path of current.files.keys())
      if (!before.has(path))
        await removeFileOrEmptyDirectories(
          grant.root,
          target.location.folderPath + "/" + path,
          target.location.folderPath,
        );
    for (const [path, bytes] of before)
      await writeAtomically(grant.root, target.location.folderPath + "/" + path, bytes);
    const verified = await captureSkillTree(
      observationGrant(grant),
      target.location.folderPath,
      { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
      filesystem,
      (value) => createHash("sha256").update(value).digest("hex"),
    );
    return verified.status === "complete" && verified.revision.hash === target.localTree.revision.hash;
  } catch {
    return false;
  }
}

function targetReceipt(
  intentId: string,
  step: import("../../shared/skill-management-ipc").SkillEffectStep,
  target: ReadySkillPropagationSnapshot["locations"][number],
  now: () => number,
): OperationReceipt {
  const evidence = step.propagationEvidence!;
  const use = targetUse(step);
  const binding = step.bindingEffects[0]!;
  return {
    operationId: step.stepId,
    kind: "propagate-skill",
    status: "applied",
    appliedAt: new Date(now()).toISOString(),
    displayTarget: target.location.folderPath,
    actions: step.plan.actions.map((action) => ({ ...action, status: "applied" })),
    git: { mode: "disabled" },
    registered: null,
    source: { kind: "source", id: evidence.source.sourceId, relativePath: evidence.source.artifactPath },
    project: { id: evidence.location.projectId },
    files: evidence.sourceRevision.files.map((file) => ({
      relativePath: target.location.folderPath + "/" + file.path,
      contentHash: file.hash,
      ...(evidence.localRevision.files.find((prior) => prior.path === file.path)
        ? { previousHash: evidence.localRevision.files.find((prior) => prior.path === file.path)!.hash }
        : {}),
    })),
    skillPropagation: {
      intentId,
      stepId: step.stepId,
      skillId: evidence.skillId,
      sourceId: evidence.source.sourceId,
      location: evidence.location,
      rootIdentity: evidence.projectRootIdentity,
      beforeRevision: evidence.localRevision,
      afterRevision: evidence.sourceRevision,
      previousUse: use.before!,
      currentUse: use.after!,
      previousBinding: binding.before!,
      currentBinding: binding.after!,
      backupPath: backupRelativePath(intentId, binding.bindingId),
    },
  };
}

export async function applyPropagationTarget(
  args: SkillPropagationDependencies,
  intentId: string,
  snapshot: ReadySkillPropagationSnapshot,
  target: ReadySkillPropagationSnapshot["locations"][number],
  step: import("../../shared/skill-management-ipc").SkillEffectStep,
  progress: SkillStepProgress,
): Promise<
  Readonly<{ result: "applied" | "no-op" | "failed" | "unknown"; receipt?: OperationReceipt; issue?: SkillIssue }>
> {
  const now = args.now ?? Date.now;
  let grant: RegistryGrant | undefined;
  let filesApplyStarted = false;
  let bindingChanged = false;
  let useChanged = false;
  try {
    const fresh = await validateTarget(args, snapshot, target);
    grant = fresh.grant;
    const use = targetUse(step);
    const binding = step.bindingEffects[0]!;
    const baseId = use.after!.baseRevisionId;
    await args.bases.publish(baseId, snapshot.projectedSource.revision, snapshot.projectedSource.files);
    if (step.plan.actions.length) {
      await applyFiles(args, grant, step, target, () => {
        filesApplyStarted = true;
      });
    }
    const updatedBinding = await args.bindings.updateExact([
      { bindingId: binding.bindingId, expected: binding.before, next: binding.after },
    ]);
    if (updatedBinding.status !== "ready") throw new Error("The managed Binding could not be advanced safely.");
    bindingChanged = true;
    const updatedUse = await args.relationships.updateUsesExact(fresh.relationshipRevision, [use]);
    if (updatedUse.status !== "saved") throw new Error("The managed-use base could not be advanced safely.");
    useChanged = true;
    const receipt = targetReceipt(intentId, step, target, now);
    const stored = await args.operationStore.append(receipt);
    if (stored.status !== "ready") throw new Error("The target receipt could not be stored safely.");
    await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId });
    return { result: "applied", receipt };
  } catch (error: unknown) {
    const rollbackSucceeded =
      grant && filesApplyStarted && !useChanged
        ? await rollbackFiles(args, grant, target, snapshot.projectedSource.files)
        : true;
    if (bindingChanged && !useChanged) {
      const binding = step.bindingEffects[0]!;
      const reverted = await args.bindings
        .updateExact([{ bindingId: binding.bindingId, expected: binding.after, next: binding.before }])
        .catch(() => undefined);
      if (!reverted || reverted.status !== "ready")
        return { result: "unknown", issue: errorIssue(error, "target-recovery-required") };
    }
    const unknown = useChanged || (grant !== undefined && !rollbackSucceeded);
    await progress({ stepId: step.stepId, status: unknown ? "recovery-required" : "failed" }).catch(() => undefined);
    return {
      result: unknown ? "unknown" : "failed",
      issue: errorIssue(error, unknown ? "target-recovery-required" : "target-apply-failed"),
    };
  }
}
