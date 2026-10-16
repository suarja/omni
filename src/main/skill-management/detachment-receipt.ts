import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";

export function createSkillDetachmentReceipt(
  intentId: string,
  step: SkillEffectStep,
  now: () => number,
  restores?: string,
): OperationReceipt {
  const evidence = step.detachmentEvidence;
  if (!evidence || step.plan.kind !== "detach-skill")
    throw new Error("The saved stop-management step cannot produce a receipt.");
  const location = evidence.local.location;
  return {
    operationId: step.stepId,
    kind: "detach-skill",
    status: "applied",
    appliedAt: new Date(now()).toISOString(),
    displayTarget: location.folderPath,
    actions: [],
    git: { mode: "unavailable" },
    registered: null,
    source: {
      kind: "source",
      id: evidence.use.source.sourceId,
      relativePath: evidence.use.source.artifactPath,
    },
    project: { id: location.projectId },
    detachment: { intentId, stepId: step.stepId },
    ...(restores ? { restores } : {}),
  };
}
