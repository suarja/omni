import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { PublicationReceipt } from "./variant-publication";

export function createSkillVariantCaptureReceipt(
  intentId: string,
  step: SkillEffectStep,
  publication: PublicationReceipt,
  appliedAt: string,
): OperationReceipt {
  const evidence = step.variantCaptureEvidence;
  if (!evidence || step.plan.kind !== "capture-skill")
    throw new Error("The saved personal variant capture step is unavailable.");
  return {
    operationId: step.stepId,
    kind: "capture-skill",
    status: "applied",
    appliedAt,
    displayTarget: `${evidence.destination.source.packageId}/${evidence.destination.source.artifactPath}`,
    actions: step.plan.actions.map((action) => ({ ...action, status: "applied" as const })),
    git: { mode: "disabled" },
    registered: null,
    source: {
      kind: "source",
      id: evidence.destination.source.sourceId,
      relativePath: evidence.destination.packageRoot,
    },
    files: publication.files.map(({ relativePath, hash }) => ({ relativePath, contentHash: hash })),
    manifests: [
      {
        relativePath: publication.manifest.relativePath,
        beforeHash: publication.manifest.beforeHash,
        afterHash: publication.manifest.afterHash,
      },
    ],
    createdDirectories: publication.directories,
    capture: { intentId, stepId: step.stepId },
  };
}
