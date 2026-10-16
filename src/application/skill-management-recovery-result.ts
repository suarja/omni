import type { SkillOperationJournalRecord } from "./skill-management-journal";
import type { SkillIssue, SkillResult } from "../shared/skill-management-ipc";
import type { SkillVariantCaptureDetails } from "../shared/skill-variant-effects";
import type { SkillUnboundResolutionDetails } from "../shared/skill-unbound-resolution-effects";
import type { SkillDetachmentDetails } from "../shared/skill-detachment-effects";

function issue(code: string, message: string, recoveryAction: SkillIssue["recoveryAction"]): SkillIssue {
  return { code, message, recoveryAction };
}

export function recoveryResult(record: SkillOperationJournalRecord): SkillResult {
  const isCapture = record.intent.kind === "reconcile" && record.intent.request.choice === "keep-variant";
  const targets = isCapture
    ? []
    : (record.effect?.steps ?? []).flatMap((effect) => {
        const saved = record.steps.find((step) => step.stepId === effect.stepId);
        const status =
          saved?.status === "applied"
            ? record.intent.kind === "remove"
              ? ("removed" as const)
              : record.intent.kind === "restore"
                ? ("restored" as const)
                : ("applied" as const)
            : saved?.status === "skipped" || saved?.status === "prepared"
              ? ("skipped" as const)
              : ("unknown" as const);
        return effect.scope.targets.map((target) => ({
          ...target,
          bindingId: target.bindingId ?? effect.stepId,
          artifactPath:
            effect.bindingEffects[0]?.after?.artifactPath ??
            effect.bindingEffects[0]?.before?.artifactPath ??
            effect.scope.artifactPath ??
            "unknown",
          status,
        }));
      });
  const reconciliationStep = record.effect?.steps.find(
    (effect) =>
      effect.adoptionEvidence ||
      effect.resolutionEvidence ||
      effect.variantCaptureEvidence ||
      effect.unboundResolutionEvidence ||
      effect.detachmentEvidence,
  );
  const savedReconciliationStep =
    reconciliationStep && record.steps.find((step) => step.stepId === reconciliationStep.stepId);
  const resolution: SkillResult["resolution"] =
    record.intent.kind === "reconcile" && reconciliationStep?.resolutionEvidence
      ? {
          skillId: reconciliationStep.resolutionEvidence.skillId,
          choice: reconciliationStep.resolutionEvidence.choice,
          targets: [
            {
              location: reconciliationStep.resolutionEvidence.local.location,
              bindingId: reconciliationStep.resolutionEvidence.use.bindingId,
              status:
                savedReconciliationStep?.status === "applied"
                  ? reconciliationStep.resolutionEvidence.choice === "keep-local"
                    ? "retained-local"
                    : "applied"
                  : savedReconciliationStep?.status === "failed"
                    ? "failed"
                    : "unknown",
            },
          ],
        }
      : record.intent.kind === "reconcile" && reconciliationStep?.adoptionEvidence
        ? {
            skillId: record.intent.request.skillId,
            choice: "adopt-exact",
            targets:
              reconciliationStep.metadataEffects?.map((effect) => ({
                location: effect.location,
                bindingId: effect.after?.bindingId ?? effect.before!.bindingId,
                status:
                  savedReconciliationStep?.status === "applied"
                    ? ("applied" as const)
                    : savedReconciliationStep?.status === "failed"
                      ? ("failed" as const)
                      : ("unknown" as const),
              })) ?? [],
          }
        : undefined;
  const variantEvidence = reconciliationStep?.variantCaptureEvidence;
  const capture: SkillVariantCaptureDetails | undefined =
    record.intent.kind === "reconcile" && record.intent.request.choice === "keep-variant" && variantEvidence
      ? {
          choice: "keep-variant",
          skillId: variantEvidence.request.skillId,
          variantId: variantEvidence.origin.variantId,
          location: variantEvidence.request.locations[0]!,
          destination: variantEvidence.destination.source,
          status:
            savedReconciliationStep?.status === "applied"
              ? "applied"
              : savedReconciliationStep?.status === "failed"
                ? "failed"
                : "unknown",
        }
      : undefined;
  const unboundEvidence = reconciliationStep?.unboundResolutionEvidence;
  const linkedBinding = reconciliationStep?.bindingEffects.find((effect) => effect.after ?? effect.before);
  const link: SkillResult["link"] =
    record.intent.kind === "reconcile" &&
    record.intent.request.choice === "link-canonical" &&
    unboundEvidence &&
    linkedBinding
      ? {
          choice: "link-canonical",
          skillId: unboundEvidence.skillId,
          source: unboundEvidence.source.ref,
          location: unboundEvidence.local.location,
          bindingId: linkedBinding.bindingId,
          status:
            savedReconciliationStep?.status === "applied"
              ? "applied"
              : savedReconciliationStep?.status === "failed"
                ? "failed"
                : "unknown",
        }
      : undefined;
  const detachmentStep = reconciliationStep?.detachmentEvidence ? reconciliationStep : undefined;
  const detachmentStatus: NonNullable<SkillResult["detachment"]>["status"] =
    savedReconciliationStep?.status === "applied"
      ? detachmentStep?.detachmentRestoreOrigin
        ? "restored"
        : "detached"
      : savedReconciliationStep?.status === "failed"
        ? "failed"
        : "unknown";
  const detachment: SkillResult["detachment"] =
    record.intent.kind === "reconcile" && record.intent.request.choice === "detach-managed" && detachmentStep
      ? {
          choice: "detach-managed",
          skillId: detachmentStep.detachmentEvidence!.skillId,
          location: detachmentStep.detachmentEvidence!.local.location,
          source: detachmentStep.detachmentEvidence!.use.source,
          bindingId: detachmentStep.detachmentEvidence!.binding.bindingId,
          status: detachmentStatus,
        }
      : undefined;
  const propagation = record.effect?.propagation
    ? {
        ...record.effect.propagation,
        targets: record.effect.propagation.targets.map((target) => {
          const effectStep = record.effect?.steps.find((step) =>
            step.scope.targets.some(
              (scope) =>
                scope.projectId === target.location.projectId &&
                scope.harnessId === target.location.harnessId &&
                (!target.bindingId || scope.bindingId === target.bindingId),
            ),
          );
          const saved = effectStep && record.steps.find((step) => step.stepId === effectStep.stepId);
          const result: NonNullable<(typeof target)["result"]> =
            saved?.status === "applied"
              ? target.state === "already-current"
                ? "no-op"
                : "applied"
              : saved?.status === "failed"
                ? "failed"
                : saved?.status === "applying" || saved?.status === "recovery-required"
                  ? "unknown"
                  : target.state === "retained-local"
                    ? "retained-local"
                    : target.state === "unavailable" || target.state === "withheld"
                      ? "unavailable"
                      : "pending";
          return { ...target, result };
        }),
      }
    : undefined;
  const sourceStep = record.effect?.steps.find((step) => step.plan.kind === "write-skill");
  const savedSourceStep = sourceStep && record.steps.find((step) => step.stepId === sourceStep.stepId);
  return {
    intentId: record.intentId,
    operationId: record.intentId,
    status: "recovery-required",
    source: {
      status:
        record.intent.kind === "write" || record.intent.kind === "update-and-maintain"
          ? savedSourceStep?.status === "applied"
            ? "updated"
            : "unknown"
          : "unchanged",
      ...(record.effect?.scope.sourceId ? { sourceId: record.effect.scope.sourceId } : {}),
    },
    targets,
    receiptIds: record.steps.flatMap((step) => (step.receiptId ? [step.receiptId] : [])),
    issues: [
      issue(
        "recovery-required",
        "The operation stopped before all effects could be verified. Review recovery before continuing.",
        "inspect-recovery",
      ),
    ],
    recoveryAvailable: record.backupReferences.length > 0 || Boolean(reconciliationStep),
    ...(resolution ? { resolution } : {}),
    ...(capture ? { capture } : {}),
    ...(link ? { link } : {}),
    ...(detachment ? { detachment } : {}),
    ...(propagation ? { propagation } : {}),
  };
}
