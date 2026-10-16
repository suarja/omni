import { createHash } from "node:crypto";

import type { Binding } from "../../domain/assignment-plan";
import type { OperationPlan, OperationReceipt } from "../../shared/operations-ipc";
import type {
  SkillEffectBuild,
  SkillEffectDraft,
  SkillEffectOutcome,
  SkillStepProgress,
} from "../../application/skill-management";
import type { SkillEffectFingerprint } from "../../domain/skill-management-intent";
import type {
  SkillEffectStep,
  SkillIntent,
  SkillIssue,
  SkillResult,
  SkillScope,
} from "../../shared/skill-management-ipc";
import type { ApplyRestoreBridge } from "../apply-ipc";
import type { BindingsIpcServices } from "../bindings-ipc";
import type { OperationStore } from "../operation-store";
import type { RegistryIpcServices } from "../registry-ipc";

type RemoveIntent = Extract<SkillIntent, { kind: "remove" }>;

function issue(
  code: string,
  message: string,
  recoveryAction: SkillIssue["recoveryAction"],
  binding?: Binding,
): SkillIssue {
  return {
    code,
    message,
    recoveryAction,
    ...(binding ? { projectId: binding.projectId } : {}),
  };
}

function blocked(code: string, message: string, binding?: Binding): SkillEffectBuild {
  return { status: "blocked", reason: message, details: [issue(code, message, "inspect-recovery", binding)] };
}

function receiptBinding(receipt: OperationReceipt, bindingId: string): Binding | undefined {
  const record = receipt.bindings?.find((effect) => effect.bindingId === bindingId);
  return record?.before ?? record?.binding;
}

function recordedRemoval(receipts: readonly OperationReceipt[], bindingId: string): Binding | undefined {
  const receipt = receipts
    .filter((candidate) => candidate.kind === "remove-binding" && candidate.status === "applied" && !candidate.restored)
    .filter((candidate) => candidate.bindings?.some((effect) => effect.bindingId === bindingId))
    .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))[0];
  return receipt ? receiptBinding(receipt, bindingId) : undefined;
}

function operationIdFor(intentId: string, bindingId: string): string {
  return createHash("sha256").update(`${intentId}\n${bindingId}`, "utf8").digest("hex");
}

function targetFor(binding: Binding, status: SkillResult["targets"][number]["status"]): SkillResult["targets"][number] {
  return {
    projectId: binding.projectId,
    harnessId: binding.harnessId,
    bindingId: binding.bindingId,
    artifactPath: binding.artifactPath,
    status,
  };
}

function noOpStep(binding: Binding): SkillEffectStep {
  const stepId = `noop-${binding.bindingId}`;
  const scope = {
    sourceId: binding.sourceId,
    packageId: binding.packageId,
    artifactPath: binding.artifactPath,
    targets: [{ projectId: binding.projectId, harnessId: binding.harnessId, bindingId: binding.bindingId }],
  };
  const plan: OperationPlan = {
    planId: stepId,
    kind: "remove-binding",
    displayTarget: binding.artifactPath,
    actions: [],
    git: { mode: "unavailable", warnings: [] },
  };
  return {
    stepId,
    scope,
    plan,
    bindingEffects: [{ bindingId: binding.bindingId, before: binding, after: binding }],
    files: [],
  };
}

function removalStep(
  binding: Binding,
  preview: Exclude<Awaited<ReturnType<ApplyRestoreBridge["previewRemove"]>>, { status: "blocked" }>,
): SkillEffectStep {
  const scope = {
    sourceId: binding.sourceId,
    packageId: binding.packageId,
    artifactPath: binding.artifactPath,
    targets: [{ projectId: binding.projectId, harnessId: binding.harnessId, bindingId: binding.bindingId }],
  };
  const files = preview.files.map((file) => ({
    rootId: binding.projectId,
    relativePath: file.relativePath,
    change: "delete" as const,
    beforeHash: file.contentHash,
    ...(file.diff ? { diff: file.diff.text } : {}),
  }));
  const plan: OperationPlan = {
    planId: preview.planId,
    kind: "remove-binding",
    displayTarget: preview.project.displayName,
    actions: preview.files.map((file) => ({
      kind: "delete-file" as const,
      relativePath: file.relativePath,
      beforeHash: file.contentHash,
      ...(file.diff ? { diff: file.diff.text } : {}),
    })),
    git: { mode: preview.git.mode, warnings: [] },
    ...(preview.notes ? { notes: preview.notes } : {}),
  };
  return {
    stepId: preview.planId,
    scope,
    plan,
    bindingEffects: [{ bindingId: binding.bindingId, before: binding }],
    files,
  };
}

function sameBinding(left: Binding, right: Binding): boolean {
  return (
    JSON.stringify(Object.entries(left).sort(([a], [b]) => a.localeCompare(b))) ===
    JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)))
  );
}

function isNoOp(step: SkillEffectStep): boolean {
  const effect = step.bindingEffects[0];
  return step.files.length === 0 && Boolean(effect?.before && effect.after && sameBinding(effect.before, effect.after));
}

function scopeFor(steps: readonly SkillEffectStep[]): SkillScope {
  const bindings = steps.flatMap((step) =>
    step.bindingEffects.map((effect) => effect.before ?? effect.after).filter((item): item is Binding => Boolean(item)),
  );
  const common = (key: "sourceId" | "packageId" | "artifactPath") =>
    bindings.every((binding) => binding[key] === bindings[0]?.[key]) ? bindings[0]?.[key] : undefined;
  return {
    ...(common("sourceId") ? { sourceId: common("sourceId") } : {}),
    ...(common("packageId") ? { packageId: common("packageId") } : {}),
    ...(common("artifactPath") ? { artifactPath: common("artifactPath") } : {}),
    targets: steps.flatMap((step) => step.scope.targets),
  };
}

function effectFor(steps: readonly SkillEffectStep[], intentId: string): SkillEffectBuild {
  const scope = scopeFor(steps);
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
  const backupReferences = steps
    .filter((step) => !isNoOp(step))
    .flatMap((step) => {
      const bindingId = step.scope.targets[0]?.bindingId;
      const projectId = step.scope.targets[0]?.projectId;
      return bindingId && projectId
        ? [{ rootId: projectId, path: `backups/${operationIdFor(intentId, bindingId)}/${projectId}` }]
        : [];
    });
  return {
    status: "ready",
    planId: createHash("sha256")
      .update(steps.map((step) => step.stepId).join("\n"), "utf8")
      .digest("hex"),
    scope,
    steps,
    fingerprint: { scope, files, bindings, actions },
    backupReferences,
  };
}

function targetsFor(step: SkillEffectStep, status: SkillResult["targets"][number]["status"]): SkillResult["targets"] {
  return step.bindingEffects.flatMap((effect) => {
    const binding = effect.before ?? effect.after;
    return binding ? [targetFor(binding, status)] : [];
  });
}

export function createSkillRemovalAdapter(
  args: Readonly<{
    registry: RegistryIpcServices;
    bindings: BindingsIpcServices;
    applyRestore: ApplyRestoreBridge;
    operationStore: OperationStore;
  }>,
): Readonly<{
  preview(intent: RemoveIntent, intentId: string): Promise<SkillEffectBuild>;
  prepare(intentId: string, effect: SkillEffectDraft): Promise<void>;
  apply(intentId: string, effect: SkillEffectDraft, progress?: SkillStepProgress): Promise<SkillEffectOutcome>;
}> {
  const preview = async (intent: RemoveIntent, intentId: string): Promise<SkillEffectBuild> => {
    const current = await args.bindings.readBindings();
    if (current.status !== "ready") return blocked("bindings-unavailable", "Managed bindings are unavailable.");
    const history = await args.operationStore.read();
    if (history.status !== "ready") return blocked("receipt-unavailable", "Removal history is unavailable.");
    const byId = new Map(current.bindings.map((binding) => [binding.bindingId, binding]));
    const steps: SkillEffectStep[] = [];
    for (const bindingId of intent.bindingIds) {
      const binding = byId.get(bindingId);
      if (!binding) {
        const prior = recordedRemoval(history.receipts, bindingId);
        if (!prior) return blocked("binding-unavailable", "The selected managed binding is unavailable.");
        steps.push(noOpStep(prior));
        continue;
      }
      const grantHandle = await args.registry.getGrantForEntry({ kind: "project", id: binding.projectId });
      if (!grantHandle)
        return blocked("project-grant-unavailable", "Reopen the project before removing this managed skill.", binding);
      const response = await args.applyRestore.previewRemove({ bindingId, grantHandle });
      if (response.status === "blocked")
        return blocked(
          response.reason,
          response.diagnostic ?? "The managed target cannot be inspected safely.",
          binding,
        );
      const modified = response.files.find((file) => file.modified);
      if (modified)
        return {
          status: "blocked",
          reason: `The managed target file changed locally: ${modified.relativePath}`,
          details: [
            {
              ...issue(
                "target-modified",
                `The managed target file changed locally: ${modified.relativePath}`,
                "inspect-recovery",
                binding,
              ),
              relativePath: modified.relativePath,
            },
          ],
        };
      steps.push(removalStep(binding, response));
    }
    return effectFor(steps, intentId);
  };

  const prepare = async (_intentId: string, _effect: SkillEffectDraft): Promise<void> => undefined;

  const apply = async (
    intentId: string,
    effect: SkillEffectDraft,
    progress: SkillStepProgress = async () => undefined,
  ): Promise<SkillEffectOutcome> => {
    const source = {
      status: "unchanged" as const,
      ...(effect.scope.sourceId ? { sourceId: effect.scope.sourceId } : {}),
    };
    if (effect.steps.every(isNoOp))
      return {
        status: "no-op",
        source,
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
      if (isNoOp(step)) {
        targets.push(...targetsFor(step, "no-op"));
        continue;
      }
      const bindingId = step.scope.targets[0]?.bindingId;
      if (!bindingId) throw new Error("Removal preview is missing its selected binding id.");
      await progress({ stepId: step.stepId, status: "applying" });
      const response = await args.applyRestore.runRemove({
        planId: step.plan.planId,
        operationId: operationIdFor(intentId, bindingId),
      });
      if (response.status === "blocked") {
        await progress({ stepId: step.stepId, status: "failed" });
        for (const skipped of effect.steps.slice(index + 1))
          await progress({ stepId: skipped.stepId, status: "skipped" });
        issues.push(
          issue(
            response.reason,
            response.diagnostic ?? "The managed target could not be removed safely.",
            "refresh",
            step.bindingEffects[0]?.before,
          ),
        );
        targets.push(...targetsFor(step, "failed"));
        for (const skipped of effect.steps.slice(index + 1))
          await progress({ stepId: skipped.stepId, status: "skipped" });
        for (const skipped of effect.steps.slice(index + 1)) targets.push(...targetsFor(skipped, "skipped"));
        return {
          status: receipts.some((receipt) => receipt.status === "applied") ? "partial" : "failed",
          source,
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
      if (response.status === "failed" || response.receipt.status === "failed") {
        issues.push(
          issue(
            "removal-failed",
            response.receipt.diagnostic ?? "The managed target could not be removed safely.",
            "inspect-recovery",
            step.bindingEffects[0]?.before,
          ),
        );
        targets.push(...targetsFor(step, "failed"));
        for (const skipped of effect.steps.slice(index + 1))
          await progress({ stepId: skipped.stepId, status: "skipped" });
        for (const skipped of effect.steps.slice(index + 1)) targets.push(...targetsFor(skipped, "skipped"));
        return {
          status: receipts.some((receipt) => receipt.status === "applied") ? "partial" : "failed",
          source,
          targets,
          receiptIds: receipts.map((receipt) => receipt.operationId),
          receipts,
          issues,
          recoveryAvailable: true,
        };
      }
      targets.push(...targetsFor(step, "removed"));
    }
    return {
      status: targets.every((target) => target.status === "no-op") ? "no-op" : "applied",
      source,
      targets,
      receiptIds: receipts.map((receipt) => receipt.operationId),
      receipts,
      issues,
      recoveryAvailable: false,
    };
  };

  return { preview, prepare, apply };
}
