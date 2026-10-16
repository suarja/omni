import { createHash } from "node:crypto";

import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type { RegistryIpcServices } from "../registry-ipc";
import type { BindingsIpcServices } from "../bindings-ipc";
import type { ApplyRestoreBridge, ManagedAssignmentRequest } from "../apply-ipc";
import type { SkillEffectStep, SkillIntent, SkillIssue, SkillResult } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";

function issue(
  code: string,
  message: string,
  recoveryAction: SkillIssue["recoveryAction"],
  projectId?: string,
): SkillIssue {
  return { code, message, recoveryAction, ...(projectId ? { projectId } : {}) };
}

function unavailable(code: string, message: string, projectId?: string): SkillEffectBuild {
  return { status: "blocked", reason: message, details: [issue(code, message, "reconnect", projectId)] };
}

function stepFor(
  plan: Awaited<ReturnType<ApplyRestoreBridge["previewManagedAssignment"]>>,
): SkillEffectStep | undefined {
  if ("status" in plan) return undefined;
  const scope = {
    targets: plan.bindingEffects.flatMap((effect) => {
      const binding = effect.after ?? effect.before;
      return binding
        ? [{ projectId: binding.projectId, harnessId: binding.harnessId, bindingId: binding.bindingId }]
        : [];
    }),
  };
  return {
    stepId: plan.planId,
    scope,
    plan: plan.plan,
    bindingEffects: plan.bindingEffects,
    files: plan.files,
  };
}

function effectFor(
  steps: readonly SkillEffectStep[],
  intent: Extract<SkillIntent, { kind: "assign" }>,
  intentId: string,
): SkillEffectBuild {
  const scope = {
    sourceId: intent.sourceId,
    packageId: intent.packageId,
    ...(intent.artifactPath ? { artifactPath: intent.artifactPath } : {}),
    targets: steps.flatMap((step) =>
      step.bindingEffects.flatMap((effect) => {
        const binding = effect.after ?? effect.before;
        return binding
          ? [{ projectId: binding.projectId, harnessId: binding.harnessId, bindingId: binding.bindingId }]
          : [];
      }),
    ),
  };
  const files = steps.flatMap((step) => step.files);
  const bindings = steps.flatMap((step) => step.bindingEffects);
  const actions: NonNullable<SkillEffectFingerprint["actions"]> = steps.flatMap((step) =>
    step.plan.actions.map((action) => ({
      rootId: step.scope.targets[0]?.projectId ?? intentId,
      kind: action.kind,
      relativePath: action.relativePath,
      ...(action.beforeHash === undefined ? {} : { beforeHash: action.beforeHash }),
      ...(action.afterHash === undefined ? {} : { afterHash: action.afterHash }),
    })),
  );
  const planId = createHash("sha256")
    .update(steps.map((step) => step.stepId).join("\n"), "utf8")
    .digest("hex");
  return {
    status: "ready",
    planId,
    scope,
    steps,
    fingerprint: { scope, files, bindings, actions },
    backupReferences: steps.map((step) => ({
      rootId: step.scope.targets[0]?.projectId ?? intentId,
      path: `backups/skill-intents/${intentId}/${step.scope.targets[0]?.projectId ?? intentId}`,
    })),
  };
}

function targetsFor(step: SkillEffectStep, status: SkillResult["targets"][number]["status"]): SkillResult["targets"] {
  return step.bindingEffects.flatMap((effect) => {
    const binding = effect.after ?? effect.before;
    return binding
      ? [
          {
            projectId: binding.projectId,
            harnessId: binding.harnessId,
            bindingId: binding.bindingId,
            artifactPath: binding.artifactPath,
            status,
          },
        ]
      : [];
  });
}

function isNoOp(step: SkillEffectStep): boolean {
  return (
    step.files.every((file) => file.change === "unchanged") &&
    step.bindingEffects.every((effect) => {
      if (!effect.before || !effect.after) return false;
      const before = Object.entries(effect.before).sort(([left], [right]) => left.localeCompare(right));
      const after = Object.entries(effect.after).sort(([left], [right]) => left.localeCompare(right));
      return JSON.stringify(before) === JSON.stringify(after);
    })
  );
}

export function createSkillAssignmentAdapter(
  args: Readonly<{
    registry: RegistryIpcServices;
    bindings: BindingsIpcServices;
    applyRestore: ApplyRestoreBridge;
  }>,
): Readonly<{
  preview(intent: Extract<SkillIntent, { kind: "assign" }>, intentId: string): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress?: SkillStepProgress): Promise<SkillEffectOutcome>;
}> {
  const preview = async (
    intent: Extract<SkillIntent, { kind: "assign" }>,
    intentId: string,
  ): Promise<SkillEffectBuild> => {
    const sourceGrantHandle = await args.registry.getGrantForEntry({ kind: "source", id: intent.sourceId });
    if (!sourceGrantHandle)
      return unavailable("source-grant-unavailable", "Open the source again before assigning its skill.");
    const steps: SkillEffectStep[] = [];
    for (const target of intent.targets) {
      const projectGrantHandle = await args.registry.getGrantForEntry({ kind: "project", id: target.projectId });
      if (!projectGrantHandle)
        return unavailable(
          "project-grant-unavailable",
          "Open the project again before assigning this skill.",
          target.projectId,
        );
      const bindings = await args.bindings.previewBindings({
        source: { id: intent.sourceId, grantHandle: sourceGrantHandle },
        packageId: intent.packageId,
        ...(intent.artifactPath ? { artifactPath: intent.artifactPath } : {}),
        projects: [{ projectId: target.projectId, grantHandle: projectGrantHandle, harnessIds: target.harnessIds }],
      });
      if (bindings.status !== "ready")
        return unavailable(
          "assignment-preview-unavailable",
          "The source or project access changed; reopen it and refresh.",
          target.projectId,
        );
      const blockedPlan = bindings.plans.find((plan) => plan.status === "blocked");
      if (blockedPlan)
        return {
          status: "blocked",
          reason: "A selected target is unavailable.",
          details: [
            issue(
              "target-unavailable",
              "The selected harness target is blocked. Choose another target or reconnect the project.",
              "choose-targets",
              target.projectId,
            ),
          ],
        };
      const conflictPlan = bindings.plans.find((plan) => plan.status === "conflict");
      if (conflictPlan)
        return {
          status: "needs-input",
          reason: "An existing project copy needs an explicit decision.",
          details: [
            issue(
              "unbound-copy",
              "An existing unbound copy cannot be adopted by this assignment. Inspect it or choose a different target.",
              "open-changes",
              target.projectId,
            ),
          ],
        };
      if (!bindings.bindings?.length)
        return unavailable(
          "binding-preview-incomplete",
          "The assignment preview did not include the selected binding records.",
          target.projectId,
        );
      const request: ManagedAssignmentRequest = {
        projectId: target.projectId,
        sourceId: intent.sourceId,
        packageId: intent.packageId,
        ...(intent.artifactPath ? { artifactPath: intent.artifactPath } : {}),
        sourceGrantHandle,
        projectGrantHandle,
        bindings: bindings.bindings,
      };
      const managed = await args.applyRestore.previewManagedAssignment(request);
      if ("status" in managed)
        return {
          status: "blocked",
          reason: managed.diagnostic ?? managed.reason,
          details: [
            issue(
              managed.reason,
              managed.diagnostic ?? "The assignment could not be prepared.",
              "refresh",
              target.projectId,
            ),
          ],
        };
      const step = stepFor(managed);
      if (!step)
        return unavailable(
          "assignment-preview-incomplete",
          "The assignment plan could not be described safely.",
          target.projectId,
        );
      steps.push(step);
    }
    return effectFor(steps, intent, intentId);
  };

  const prepare = async (intentId: string, effect: SkillEffectDraft): Promise<void> => {
    for (const step of effect.steps) await args.applyRestore.prepareManagedAssignment(step.plan.planId, intentId);
  };

  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress = async () => undefined,
  ): Promise<SkillEffectOutcome> => {
    if (effect.steps.every(isNoOp))
      return {
        status: "no-op",
        source: { status: "unchanged", ...(effect.scope.sourceId ? { sourceId: effect.scope.sourceId } : {}) },
        targets: effect.steps.flatMap((step) => targetsFor(step, "no-op")),
        receiptIds: [],
        receipts: [],
        issues: [],
        recoveryAvailable: false,
      };
    const receipts: OperationReceipt[] = [];
    const targets: SkillResult["targets"][number][] = [];
    const issues: SkillIssue[] = [];
    for (const [index, step] of effect.steps.entries()) {
      await progress({ stepId: step.stepId, status: "applying" });
      const response = await args.applyRestore.runManagedAssignment(step.plan.planId);
      if (response.status === "blocked") {
        await progress({ stepId: step.stepId, status: "failed" });
        for (const skipped of effect.steps.slice(index + 1))
          await progress({ stepId: skipped.stepId, status: "skipped" });
        issues.push(
          issue(
            response.reason,
            response.diagnostic ?? "The selected project could not be updated.",
            "refresh",
            step.scope.targets[0]?.projectId,
          ),
        );
        targets.push(...targetsFor(step, "failed"));
        for (const skipped of effect.steps.slice(index + 1))
          await progress({ stepId: skipped.stepId, status: "skipped" });
        for (const skipped of effect.steps.slice(index + 1)) targets.push(...targetsFor(skipped, "skipped"));
        return {
          status: receipts.length ? "partial" : "failed",
          source: { status: "unchanged", ...(effect.scope.sourceId ? { sourceId: effect.scope.sourceId } : {}) },
          targets,
          receiptIds: receipts.map((receipt) => receipt.operationId),
          receipts,
          issues,
          recoveryAvailable: receipts.length > 0,
        };
      }
      receipts.push(response.receipt);
      await progress({
        stepId: step.stepId,
        status: response.receipt.status === "applied" ? "applied" : "failed",
        receiptId: response.receipt.operationId,
      });
      const targetStatus =
        response.status === "applied" && isNoOp(step) ? "no-op" : response.status === "applied" ? "applied" : "failed";
      targets.push(...targetsFor(step, targetStatus));
      if (response.status === "failed") {
        issues.push(
          issue(
            "assignment-failed",
            response.receipt.diagnostic ??
              "The project assignment failed and its touched files were rolled back where possible.",
            "inspect-recovery",
            step.scope.targets[0]?.projectId,
          ),
        );
        for (const skipped of effect.steps.slice(index + 1))
          await progress({ stepId: skipped.stepId, status: "skipped" });
        for (const skipped of effect.steps.slice(index + 1)) targets.push(...targetsFor(skipped, "skipped"));
        return {
          status: receipts.length > 1 ? "partial" : "failed",
          source: { status: "unchanged", ...(effect.scope.sourceId ? { sourceId: effect.scope.sourceId } : {}) },
          targets,
          receiptIds: receipts.map((receipt) => receipt.operationId),
          receipts,
          issues,
          recoveryAvailable: true,
        };
      }
    }
    return {
      status: targets.every((target) => target.status === "no-op") ? "no-op" : "applied",
      source: { status: "unchanged", ...(effect.scope.sourceId ? { sourceId: effect.scope.sourceId } : {}) },
      targets,
      receiptIds: receipts.map((receipt) => receipt.operationId),
      receipts,
      issues,
      recoveryAvailable: false,
    };
  };

  return { preview, prepare, apply };
}
