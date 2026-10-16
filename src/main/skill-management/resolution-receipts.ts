import type { SkillEffectStep, SkillIssue, SkillResult } from "../../shared/skill-management-ipc";
import type { OperationActionReceipt, OperationReceipt } from "../../shared/operations-ipc";

export function resolutionIssue(
  code: string,
  message: string,
  recoveryAction: SkillIssue["recoveryAction"],
): SkillIssue {
  return { code, message, recoveryAction };
}

export function resolutionResultDetails(
  step: SkillEffectStep,
  status: NonNullable<SkillResult["resolution"]>["targets"][number]["status"],
) {
  const evidence = step.resolutionEvidence!;
  return {
    skillId: evidence.skillId,
    choice: evidence.choice,
    targets: [{ location: evidence.local.location, bindingId: evidence.use.bindingId, status }],
  } as const;
}

export function resolutionTargetResult(
  step: SkillEffectStep,
  status: SkillResult["targets"][number]["status"],
): SkillResult["targets"] {
  const evidence = step.resolutionEvidence!;
  return [
    {
      projectId: evidence.local.location.projectId,
      harnessId: evidence.local.location.harnessId,
      bindingId: evidence.use.bindingId,
      artifactPath: evidence.binding.artifactPath,
      status,
    },
  ];
}

export function makeSkillResolutionReceipt(
  intentId: string,
  step: SkillEffectStep,
  actions: readonly OperationActionReceipt[],
  status: "applied" | "failed",
  now: () => number,
): OperationReceipt {
  const evidence = step.resolutionEvidence!;
  return {
    operationId: step.stepId,
    kind: "resolve-skill",
    status,
    appliedAt: new Date(now()).toISOString(),
    displayTarget: evidence.local.location.folderPath,
    actions,
    git: { mode: "unavailable" },
    registered: null,
    source: { kind: "source", id: evidence.source.sourceId, relativePath: evidence.source.artifactPath },
    project: { id: evidence.local.location.projectId },
    reconciliation: { intentId, stepId: step.stepId },
  };
}
