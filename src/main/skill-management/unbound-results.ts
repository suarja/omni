import type { SkillJournalAction } from "../../application/skill-management-journal";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { SkillUnboundResolutionDetails } from "../../shared/skill-unbound-resolution-effects";
import type { OperationActionReceipt, OperationReceipt } from "../../shared/operations-ipc";

function actionStatusMap(
  actions: readonly SkillJournalAction[],
  step: SkillEffectStep,
): Map<string, OperationActionReceipt["status"]> {
  const result = new Map<string, OperationActionReceipt["status"]>();
  for (const expected of step.plan.actions) {
    const action = actions.find((item) => item.relativePath === expected.relativePath && item.kind === expected.kind);
    result.set(`${expected.kind}\n${expected.relativePath}`, action?.status === "applied" ? "applied" : "failed");
  }
  return result;
}

export function makeReceipt(
  intentId: string,
  step: SkillEffectStep,
  actions: readonly OperationActionReceipt[],
  now: () => number,
  status: "applied" | "failed",
): OperationReceipt {
  const evidence = step.unboundResolutionEvidence!;
  const binding = step.bindingEffects[0]?.after;
  if (!binding) throw new Error("The exact new Binding is missing from the saved linkage effect.");
  return {
    operationId: step.stepId,
    kind: "link-skill",
    status,
    appliedAt: new Date(now()).toISOString(),
    displayTarget: evidence.local.location.folderPath,
    actions,
    git: { mode: "unavailable" },
    registered: null,
    source: { kind: "source", id: evidence.source.ref.sourceId, relativePath: evidence.source.ref.artifactPath },
    project: { id: evidence.local.location.projectId },
    bindings: [{ bindingId: binding.bindingId, after: binding }],
    link: { intentId, stepId: step.stepId },
    createdDirectories: actions
      .filter((action) => action.kind === "create-directory" && action.status === "applied")
      .map((action) => action.relativePath),
  };
}

export function actionReceipts(
  step: SkillEffectStep,
  journalActions: readonly SkillJournalAction[],
): OperationActionReceipt[] {
  const status = actionStatusMap(journalActions, step);
  return step.plan.actions.map((action) => ({
    ...action,
    status: status.get(`${action.kind}\n${action.relativePath}`) ?? "failed",
  }));
}

export function resultLink(
  step: SkillEffectStep,
  status: "applied" | "failed" | "unknown" | "restored",
): SkillUnboundResolutionDetails | undefined {
  const evidence = step.unboundResolutionEvidence!;
  const binding = step.bindingEffects[0]?.after;
  if (!binding) return undefined;
  return {
    choice: "link-canonical" as const,
    skillId: evidence.skillId,
    source: evidence.source.ref,
    location: evidence.local.location,
    bindingId: binding.bindingId,
    status,
  };
}
