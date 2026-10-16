import { restoreExternalSkillsLock } from "../../domain/external-skill-lock";
import type { ExternalSkillEvidence } from "../../shared/external-skill-effects";
import { readRegularFile } from "../operation-files";
import { captureExactSkillTree, hashExactTree } from "../skill-management/project-skill-files";
import { externalProjectGrant, isKnownExternalPartial, readExternalBackup } from "./operation-files";
import {
  hashExternalBytes,
  serializeExternalBackup,
  type ExternalOperationDependencies,
  type ExternalTargetPlan,
} from "./operation-types";

async function invertTarget(
  args: ExternalOperationDependencies,
  evidence: ExternalSkillEvidence,
  receiptId: string,
  intentId: string,
  interrupted: boolean,
): Promise<ExternalTargetPlan> {
  const original = await readExternalBackup(args, evidence),
    grant = await externalProjectGrant(args, original.backup);
  const layouts = [];
  for (const layout of original.backup.layouts) {
    const current = await captureExactSkillTree(grant.root, layout.path);
    if (
      interrupted
        ? !isKnownExternalPartial(current, layout.before, layout.after)
        : hashExactTree(current) !== hashExactTree(layout.after)
    )
      throw new Error(
        `Project ${evidence.projectId} changed after this operation. Retain its edits and inspect recovery.`,
      );
    layouts.push({ ...layout, before: current ? [...current] : undefined, after: layout.before });
  }
  const bytes = await readRegularFile(grant.root, "skills-lock.json");
  const lockBefore = bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
  const lockAfter =
    interrupted && lockBefore === original.backup.lockBefore
      ? lockBefore
      : restoreExternalSkillsLock(lockBefore, original.backup.lockBefore, original.backup.lockAfter);
  return serializeExternalBackup({
    sources: [],
    licence: original.backup.licence,
    layouts,
    lockBefore,
    lockAfter,
    evidence: {
      ...evidence,
      direction: "restore",
      restores: receiptId,
      backupPath: `omni/backups/external-skills/${intentId}/${hashExternalBytes(JSON.stringify([intentId, receiptId]))!}.json`,
      beforeLockHash: hashExternalBytes(lockBefore),
      afterLockHash: hashExternalBytes(lockAfter),
      layouts: layouts.map((layout) => ({
        path: layout.path,
        harnessId: layout.harnessId,
        beforeHash: hashExactTree(layout.before),
        afterHash: hashExactTree(layout.after),
      })),
    },
  });
}
export async function planExternalRestoration(
  args: ExternalOperationDependencies,
  operationId: string,
  intentId: string,
): Promise<readonly ExternalTargetPlan[] | undefined> {
  const history = await args.operationStore.read(),
    saved = await args.journal.read(operationId);
  const interrupted = saved.status === "ready" && saved.record.status === "recovery-required";
  const externalSteps =
    saved.status === "ready" ? (saved.record.effect?.steps ?? []).filter((step) => step.externalSkillEvidence) : [];
  if (history.status !== "ready") {
    if (externalSteps.length)
      throw new Error("External operation History is unavailable. Restore its store before recovering files.");
    return undefined;
  }
  const original = history.receipts.find((receipt) => receipt.operationId === operationId);
  const children = original?.externalSkill
    ? [original]
    : history.receipts.filter((receipt) => original?.children?.includes(receipt.operationId) && receipt.externalSkill);
  if (!children.length && !(interrupted && externalSteps.length)) return undefined;
  const targets: ExternalTargetPlan[] = [];
  for (const receipt of children.filter((receipt) => receipt.status === "applied" && !receipt.restored))
    targets.push(await invertTarget(args, receipt.externalSkill!, receipt.operationId, intentId, false));
  if (interrupted && saved.status === "ready")
    for (const step of externalSteps) {
      const evidence = step.externalSkillEvidence!,
        progress = saved.record.steps.find((item) => item.stepId === step.stepId);
      if (
        evidence.refusal ||
        ["failed", "skipped"].includes(progress?.status ?? "") ||
        children.some((receipt) => receipt.operationId === step.stepId)
      )
        continue;
      const receipt = history.receipts.find((item) => item.operationId === step.stepId && item.externalSkill);
      if (receipt?.restored) continue;
      targets.push(await invertTarget(args, evidence, step.stepId, intentId, !receipt));
    }
  if (!targets.length) throw new Error("This external operation has no remaining copies to restore.");
  return targets;
}
export async function completeExternalRecovery(
  args: ExternalOperationDependencies,
  operationId: string,
): Promise<void> {
  const loaded = await args.journal.read(operationId);
  if (loaded.status !== "ready" || loaded.record.status !== "recovery-required") return;
  await args.journal.write({
    ...loaded.record,
    status: "terminal",
    updatedAt: new Date((args.now ?? Date.now)()).toISOString(),
    result: {
      intentId: operationId,
      operationId,
      status: "restored",
      source: { status: "unchanged" },
      targets: [],
      receiptIds: [],
      issues: [],
      recoveryAvailable: false,
    },
  });
}
