import type {
  SkillIntent,
  SkillEffectStep,
  SkillFileSummary,
  SkillPreview,
  SkillResult,
} from "../../../shared/skill-management-ipc";
import { canRetryPropagationTarget } from "./propagation/view-model";
import type { SkillPropagationTarget } from "../../../shared/skill-propagation-ipc";

export function readySteps(preview: SkillPreview | null): readonly SkillEffectStep[] {
  return preview?.status === "ready" ? preview.steps : [];
}

export function filesFor(steps: readonly SkillEffectStep[]): readonly SkillFileSummary[] {
  return steps.flatMap((step) => step.files);
}

export function resultLabel(
  result: SkillResult,
): "applied" | "no-op" | "partial" | "failed" | "cancelled" | "recovery" | "restored" | "applying" {
  if (result.status === "recovery-required") return "recovery";
  return result.status;
}

export function canReviewRestore(result: SkillResult): boolean {
  if (result.status === "recovery-required")
    return result.propagation
      ? Boolean(
          result.receipts?.some(
            (receipt) =>
              receipt.status === "applied" &&
              !receipt.restored &&
              (receipt.kind === "propagate-skill" ||
                (receipt.kind === "write-skill" && result.source.status === "updated")),
          ),
        )
      : true;
  return Boolean(
    result.receipts?.some(
      (receipt) =>
        receipt.status === "applied" &&
        !receipt.restored &&
        (receipt.kind === "write-skill" ||
          receipt.kind === "apply-plan" ||
          receipt.kind === "remove-binding" ||
          receipt.kind === "adopt-skill" ||
          (receipt.kind === "detach-skill" && result.detachment?.status === "detached") ||
          (receipt.kind === "link-skill" && result.link?.status === "applied") ||
          (receipt.kind === "capture-skill" && result.capture?.status === "applied") ||
          (receipt.kind === "propagate-skill" && result.propagation !== undefined) ||
          (receipt.kind === "resolve-skill" && result.resolution?.choice === "use-canonical")),
    ),
  );
}

export function propagationRetryIntent(
  result: SkillResult | null | undefined,
  busy: boolean,
  target: SkillPropagationTarget,
): SkillIntent | undefined {
  const summary = result?.propagation;
  if (
    !result ||
    !summary ||
    busy ||
    result.recoveryAvailable ||
    result.status === "recovery-required" ||
    result.status === "applying" ||
    !canRetryPropagationTarget(target, result)
  )
    return undefined;
  return {
    kind: "maintain-current",
    source: summary.source,
    locations: [target.location],
    retryOf: result.intentId,
  };
}
