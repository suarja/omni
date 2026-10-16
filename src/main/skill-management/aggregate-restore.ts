import { randomUUID } from "node:crypto";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillManagementEffects,
  SkillStepProgress,
  SkillEffectOutcome,
} from "../../application/skill-management";
import type { SkillActor, SkillAuthorization, SkillResult } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { OperationStore } from "../operation-store";
import type { SkillOperationJournal } from "../../application/skill-management-journal";
import { recordParentRestored } from "./restore-parent";

type ChildRestore = Readonly<{ operationId: string; effect: SkillEffectDraft }>;

export function createSkillAggregateRestore(
  store: OperationStore,
  effects: () => SkillManagementEffects,
  journal: SkillOperationJournal,
): Readonly<{
  has(planId: string): boolean;
  preview(receipt: OperationReceipt, actor: SkillActor, intentId: string, createdAt: number): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(
    intentId: string,
    actor: SkillActor,
    authorization: SkillAuthorization,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome>;
}> {
  const plans = new Map<string, Readonly<{ parentId: string; children: readonly ChildRestore[] }>>();
  const preview = async (
    receipt: OperationReceipt,
    actor: SkillActor,
    intentId: string,
    createdAt: number,
  ): Promise<SkillEffectBuild> => {
    const history = await store.read();
    if (history.status !== "ready") throw new Error("Operation history is unavailable.");
    if (
      receipt.restored ||
      (receipt.skillManagement?.status === "recovery-required" && !receipt.skillManagement.propagation)
    )
      return {
        status: "blocked",
        reason: "This operation needs recovery inspection or has already been restored.",
        details: [
          {
            code: "inspect-recovery",
            message: "Inspect the saved recovery record before restoring this operation.",
            recoveryAction: "inspect-recovery",
          },
        ],
      };
    const children: ChildRestore[] = [];
    for (const operationId of [...(receipt.children ?? [])].reverse()) {
      const child = history.receipts.find((candidate) => candidate.operationId === operationId);
      if (!child) throw new Error("An aggregate child receipt is unavailable.");
      if (
        child.restored ||
        (child.status !== "applied" && !(receipt.kind === "import-artifact" && child.kind === "skill-management"))
      )
        continue;
      const propagation = receipt.skillManagement?.propagation;
      if (propagation) {
        const pointer = child.skillPropagation;
        const verified = pointer
          ? propagation.targets.some(
              (target) =>
                target.result === "applied" &&
                target.bindingId === pointer.currentBinding.bindingId &&
                target.location.projectId === pointer.location.projectId &&
                target.location.harnessId === pointer.location.harnessId &&
                target.location.folderPath === pointer.location.folderPath,
            )
          : child.kind === "write-skill" && receipt.skillManagement?.source.status === "updated";
        if (!verified) continue;
      }
      const built = await effects().preview({ kind: "restore", operationId }, actor, intentId, createdAt);
      if (built.status !== "ready") return built;
      children.push({ operationId, effect: built });
    }
    if (!children.length)
      return {
        status: "blocked",
        reason: "There are no verified applied effects to restore.",
        details: [
          {
            code: "nothing-to-restore",
            message: "This operation did not leave an applied child to restore.",
            recoveryAction: "inspect-recovery",
          },
        ],
      };
    const planId = randomUUID();
    const steps = children.flatMap((child) => child.effect.steps);
    const scope = {
      ...(children[0].effect.scope.sourceId ? { sourceId: children[0].effect.scope.sourceId } : {}),
      targets: [
        ...new Map(
          steps.flatMap((step) => step.scope.targets).map((target) => [JSON.stringify(target), target]),
        ).values(),
      ],
    };
    plans.set(planId, { parentId: receipt.operationId, children });
    return {
      status: "ready",
      planId,
      scope,
      steps,
      fingerprint: {
        scope,
        files: steps.flatMap((step) => step.files),
        bindings: steps.flatMap((step) => step.bindingEffects),
        metadataEffects: steps.flatMap((step) => step.metadataEffects ?? []),
        actions: children.flatMap((child) => child.effect.fingerprint.actions ?? []),
      },
      backupReferences: children.flatMap((child) => child.effect.backupReferences),
      ...(receipt.skillManagement?.propagation ? { propagation: receipt.skillManagement.propagation } : {}),
    };
  };
  const prepare = async (intentId: string, effect: SkillEffectDraft): Promise<void> => {
    const saved = plans.get(effect.planId);
    if (!saved) throw new Error("The aggregate restore preview expired.");
    for (const child of saved.children) await effects().prepare(intentId, child.effect);
  };
  const apply = async (
    intentId: string,
    actor: SkillActor,
    authorization: SkillAuthorization,
    effect: SkillEffectDraft,
    progress: SkillStepProgress,
  ): Promise<SkillEffectOutcome> => {
    const saved = plans.get(effect.planId);
    if (!saved) throw new Error("The aggregate restore preview expired.");
    const targets: SkillResult["targets"][number][] = [];
    const receipts: OperationReceipt[] = [];
    let source: SkillResult["source"] = { status: "unchanged" };
    let offset = 0;
    for (const child of saved.children) {
      const childSteps = child.effect.steps.map((step, index) => ({
        ...step,
        stepId: effect.steps[offset + index].stepId,
      }));
      const childEffect = { ...child.effect, steps: childSteps };
      const result = await effects().apply(
        intentId,
        { kind: "restore", operationId: child.operationId },
        actor,
        authorization,
        childEffect,
        progress,
      );
      for (const target of result.targets) {
        const index = targets.findIndex(
          (candidate) =>
            candidate.projectId === target.projectId &&
            candidate.harnessId === target.harnessId &&
            candidate.bindingId === target.bindingId,
        );
        if (index < 0) targets.push(target);
        else targets[index] = target;
      }
      receipts.push(...(result.receipts ?? []));
      for (const [index, step] of childSteps.entries())
        await progress({
          stepId: step.stepId,
          status: result.status === "restored" ? "applied" : result.recoveryAvailable ? "recovery-required" : "failed",
          ...(result.receiptIds[index] ? { receiptId: result.receiptIds[index] } : {}),
        });
      if (result.source.status !== "unchanged") source = result.source;
      if (result.status !== "restored")
        return {
          ...result,
          status:
            result.status === "recovery-required" ? "recovery-required" : receipts.length > 1 ? "partial" : "failed",
          targets,
          source,
          receiptIds: receipts.map((item) => item.operationId),
          receipts,
        };
      offset += childSteps.length;
    }
    const history = await store.read();
    if (history.status !== "ready") throw new Error("The capture restore history is unavailable.");
    const original = history.receipts.find((receipt) => receipt.operationId === saved.parentId);
    const parent =
      original?.kind === "import-artifact"
        ? (await store.markRestored(saved.parentId),
          { status: "restored" as const, recoveryAvailable: false, propagation: undefined })
        : await recordParentRestored(store, journal, saved.parentId);
    return {
      status: parent.status,
      source,
      targets,
      receiptIds: receipts.map((item) => item.operationId),
      receipts,
      issues: [],
      recoveryAvailable: parent.recoveryAvailable,
      ...(parent.propagation ? { propagation: parent.propagation } : {}),
    };
  };
  return { has: (planId) => plans.has(planId), preview, prepare, apply };
}
