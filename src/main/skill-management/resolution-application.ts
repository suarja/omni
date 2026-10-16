import { createHash } from "node:crypto";

import type { SkillEffectOutcome, SkillStepProgress } from "../../application/skill-management";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { SkillObservationFilesystem, SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { OperationStore } from "../operation-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { currentGrantRoot } from "../granted-hashing";
import { readRegularFile, removeFileOrEmptyDirectories, writeAtomically, type FileWriter } from "../operation-files";
import { captureComplete, observationGrant, SKILL_SCAN_BUDGET_BYTES } from "./adoption-reader";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import type { SkillResolutionSnapshot } from "./resolution-reader";
import { assertResolutionWritePath } from "./resolution-write-guard";
import {
  makeSkillResolutionReceipt,
  resolutionIssue,
  resolutionResultDetails,
  resolutionTargetResult,
} from "./resolution-receipts";

type ReadySnapshot = Extract<SkillResolutionSnapshot, { status: "ready" }>;
type ResolutionApplyDependencies = Readonly<{
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  bases: SkillBaseStore;
  operationStore: OperationStore;
  filesystem?: SkillObservationFilesystem;
  fileWriter?: FileWriter;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function hash(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}

function afterUse(step: SkillEffectStep) {
  return step.metadataEffects?.[0]?.after ?? step.resolutionEvidence!.use;
}

async function verifyAppliedTree(
  snapshot: ReadySnapshot,
  step: SkillEffectStep,
  dependencies: ResolutionApplyDependencies,
): Promise<void> {
  if (!(await currentGrantRoot(snapshot.projectGrant)))
    throw new Error("The selected project root changed during canonical replacement.");
  const actual = await captureComplete(
    snapshot.projectGrant,
    snapshot.use.location.folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    dependencies.filesystem ?? strictSkillObservationFilesystem,
    (value) => createHash("sha256").update(value, "utf8").digest("hex"),
  );
  if (!actual || !snapshot.sourceTree || canonical(actual.revision) !== canonical(snapshot.sourceTree.revision))
    throw new Error("The selected complete folder does not match the approved canonical tree.");
  const useState = await dependencies.relationships.read();
  const bindingState = await dependencies.bindings.read();
  if (useState.status !== "ready" || bindingState.status !== "ready")
    throw new Error("Managed metadata could not be verified after replacement.");
  const expectedUse = afterUse(step);
  const actualUse = useState.state.uses.find(
    (use) =>
      use.location.projectId === expectedUse.location.projectId &&
      use.location.harnessId === expectedUse.location.harnessId &&
      use.location.folderPath === expectedUse.location.folderPath,
  );
  const expectedBinding = step.bindingEffects[0]?.after ?? step.resolutionEvidence!.binding;
  const actualBinding = bindingState.bindings.find((binding) => binding.bindingId === expectedBinding.bindingId);
  if (canonical(actualUse) !== canonical(expectedUse) || canonical(actualBinding) !== canonical(expectedBinding))
    throw new Error("The exact selected use or Binding failed post-write verification.");
  const baseId = expectedUse.baseRevisionId;
  const base = await dependencies.bases.read(baseId);
  const expectedBase = step.baseReferences?.find((item) => item.baseRevisionId === baseId);
  if (base.status !== "ready" || !expectedBase || canonical(base.revision) !== canonical(expectedBase.revision))
    throw new Error("The selected canonical base failed post-write verification.");
}

async function hasAnySavedEffect(
  snapshot: ReadySnapshot,
  step: SkillEffectStep,
  dependencies: ResolutionApplyDependencies,
): Promise<boolean> {
  const evidence = step.resolutionEvidence!;
  for (const file of step.files) {
    const current = await readRegularFile(snapshot.projectGrant.root, file.relativePath);
    if (hash(current) !== file.beforeHash) return true;
  }
  if (step.bindingEffects.length) {
    const saved = await dependencies.bindings.read();
    if (saved.status !== "ready") return true;
    if (
      canonical(saved.bindings.find((binding) => binding.bindingId === evidence.binding.bindingId)) !==
      canonical(step.bindingEffects[0]?.before)
    )
      return true;
  }
  if (step.metadataEffects?.length) {
    const saved = await dependencies.relationships.read();
    if (saved.status !== "ready") return true;
    const use = saved.state.uses.find(
      (candidate) =>
        candidate.location.projectId === evidence.local.location.projectId &&
        candidate.location.harnessId === evidence.local.location.harnessId &&
        candidate.location.folderPath === evidence.local.location.folderPath,
    );
    if (canonical(use) !== canonical(step.metadataEffects[0]?.before)) return true;
  }
  return false;
}

export async function applyCanonicalResolution(
  input: Readonly<{
    intentId: string;
    snapshot: ReadySnapshot;
    step: SkillEffectStep;
    progress: SkillStepProgress;
    dependencies: ResolutionApplyDependencies;
    now: () => number;
  }>,
): Promise<SkillEffectOutcome> {
  const { intentId, snapshot, step, progress, dependencies, now } = input;
  const evidence = step.resolutionEvidence!;
  const applied: import("../../shared/operations-ipc").OperationActionReceipt[] = [];
  let touchedMetadata = false;
  await progress({ stepId: step.stepId, status: "applying" });
  try {
    for (const action of step.plan.actions) {
      const summary = step.files.find((file) => file.relativePath === action.relativePath)!;
      await assertResolutionWritePath(snapshot.projectGrant, action.relativePath);
      const current = await readRegularFile(snapshot.projectGrant.root, action.relativePath);
      if (hash(current) !== summary.beforeHash)
        throw new Error(`The reviewed local file changed before replacement: ${action.relativePath}`);
      await assertResolutionWritePath(snapshot.projectGrant, action.relativePath);
      if (action.kind === "delete-file") {
        await removeFileOrEmptyDirectories(
          snapshot.projectGrant.root,
          action.relativePath,
          evidence.local.location.folderPath,
        );
      } else {
        const inner = action.relativePath.slice(evidence.local.location.folderPath.length + 1);
        const bytes = snapshot.sourceTree?.files.get(inner);
        if (!bytes || hash(bytes) !== summary.afterHash)
          throw new Error(`The approved source bytes are unavailable: ${action.relativePath}`);
        await writeAtomically(snapshot.projectGrant.root, action.relativePath, bytes, dependencies.fileWriter);
      }
      const verified = await readRegularFile(snapshot.projectGrant.root, action.relativePath);
      if (hash(verified) !== summary.afterHash)
        throw new Error(`The reviewed file effect did not verify: ${action.relativePath}`);
      applied.push({ ...action, status: "applied" });
    }
    if (step.bindingEffects.length) {
      const updated = await dependencies.bindings.updateExact(
        step.bindingEffects.map((change) => ({
          bindingId: change.bindingId,
          expected: change.before,
          next: change.after,
        })),
      );
      if (updated.status !== "ready")
        throw new Error("The selected Binding changed or could not be saved; inspect managed resolution recovery.");
      touchedMetadata = true;
    }
    if (step.metadataEffects?.length) {
      const updated = await dependencies.relationships.updateUsesExact(evidence.storeRevision, step.metadataEffects);
      if (updated.status !== "saved")
        throw new Error("The selected managed use changed or could not be saved; inspect managed resolution recovery.");
      touchedMetadata = true;
    }
    await progress({ stepId: step.stepId, status: "verifying" });
    await verifyAppliedTree(snapshot, step, dependencies);
    const receipt = makeSkillResolutionReceipt(intentId, step, applied, "applied", now);
    if ((await dependencies.operationStore.append(receipt)).status !== "ready")
      throw new Error("The managed resolution receipt could not be saved; inspect recovery.");
    await progress({ stepId: step.stepId, status: "applied", receiptId: receipt.operationId });
    return {
      status: "applied",
      source: { status: "unchanged", sourceId: evidence.source.sourceId },
      targets: resolutionTargetResult(step, "applied"),
      receiptIds: [receipt.operationId],
      receipts: [receipt],
      resolution: resolutionResultDetails(step, "applied"),
      issues: [],
      recoveryAvailable: false,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Canonical replacement stopped before verification.";
    const currentActions = [...applied];
    const failedAction = step.plan.actions[applied.length];
    if (failedAction) currentActions.push({ ...failedAction, status: "failed" });
    const changed =
      applied.length > 0 ||
      touchedMetadata ||
      (await hasAnySavedEffect(snapshot, step, dependencies).catch(() => true));
    if (!changed) {
      await progress({ stepId: step.stepId, status: "failed" });
      return {
        status: "failed",
        source: { status: "unchanged", sourceId: evidence.source.sourceId },
        targets: resolutionTargetResult(step, "failed"),
        receiptIds: [],
        resolution: resolutionResultDetails(step, "failed"),
        issues: [resolutionIssue("resolution-failed", message, "inspect-recovery")],
        recoveryAvailable: false,
      };
    }
    const receipt = makeSkillResolutionReceipt(intentId, step, currentActions, "failed", now);
    const stored = await dependencies.operationStore.append(receipt);
    if (stored.status !== "ready")
      throw new Error("Partial canonical effects could not be attributed; inspect the prepared recovery journal.");
    await progress({ stepId: step.stepId, status: "recovery-required", receiptId: receipt.operationId });
    return {
      status: "recovery-required",
      source: { status: "unknown", sourceId: evidence.source.sourceId },
      targets: resolutionTargetResult(step, "unknown"),
      receiptIds: [receipt.operationId],
      receipts: [receipt],
      resolution: resolutionResultDetails(step, "unknown"),
      issues: [resolutionIssue("resolution-recovery-required", message, "inspect-recovery")],
      recoveryAvailable: true,
    };
  }
}
