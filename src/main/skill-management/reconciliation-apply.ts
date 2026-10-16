import type { SkillEffectOutcome, SkillStepProgress } from "../../application/skill-management";
import type { SkillEffectDraft } from "../../application/skill-management";
import type { SkillReconciliationRequest } from "../../shared/skill-reconciliation-request";
import type { createSkillAdoptionAdapter } from "./adoption";
import type { createSkillResolutionAdapter } from "./resolution";
import type { createSkillVariantCaptureAdapter } from "./variant-capture";
import type { createSkillUnboundResolutionAdapter } from "./unbound-resolution";
import type { createSkillDetachmentAdapter } from "./detachment";
import { applyUnboundLink } from "./unbound-service-routes";
import { dispatchReconciliationRequest } from "./reconciliation-dispatch";

export function applySkillReconciliation(
  args: Readonly<{
    request: SkillReconciliationRequest;
    intentId: string;
    effect: SkillEffectDraft;
    progress: SkillStepProgress;
    adoption?: ReturnType<typeof createSkillAdoptionAdapter>;
    resolution?: ReturnType<typeof createSkillResolutionAdapter>;
    variantCapture?: ReturnType<typeof createSkillVariantCaptureAdapter>;
    unboundResolution?: ReturnType<typeof createSkillUnboundResolutionAdapter>;
    detachment?: ReturnType<typeof createSkillDetachmentAdapter>;
  }>,
): Promise<SkillEffectOutcome> {
  return dispatchReconciliationRequest(args.request, {
    adoptExact: () => {
      if (!args.adoption) throw new Error("The skill adoption adapter is unavailable.");
      return args.adoption.apply(args.intentId, args.effect, args.progress);
    },
    managedResolution: () => {
      if (!args.resolution) throw new Error("The managed resolution adapter is unavailable.");
      return args.resolution.apply(args.intentId, args.effect, args.progress);
    },
    variantCapture: () => {
      if (!args.variantCapture) throw new Error("The personal variant capture adapter is unavailable.");
      return args.variantCapture.apply(args.intentId, args.effect, args.progress);
    },
    unboundResolution: (request) =>
      applyUnboundLink({
        request,
        intentId: args.intentId,
        effect: args.effect,
        progress: args.progress,
        adoption: args.adoption,
        unboundResolution: args.unboundResolution,
      }),
    detachment: () => {
      if (!args.detachment) throw new Error("The skill detachment adapter is unavailable.");
      return args.detachment.apply(args.intentId, args.effect, args.progress);
    },
  });
}
