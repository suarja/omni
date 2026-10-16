import type {
  SkillReconciliationRequest,
  SkillAdoptionRequest,
  SkillManagedResolutionRequest,
} from "../../shared/skill-reconciliation-request";
import type { SkillVariantCaptureRequest } from "../../shared/skill-variant-capture-request";
import type { SkillUnboundResolutionRequest } from "../../shared/skill-unbound-resolution-request";
import type { SkillDetachmentRequest } from "../../shared/skill-detachment-request";

export function dispatchReconciliationRequest<T>(
  request: SkillReconciliationRequest,
  handlers: Readonly<{
    adoptExact: (request: SkillAdoptionRequest) => T;
    managedResolution: (request: SkillManagedResolutionRequest) => T;
    variantCapture: (request: SkillVariantCaptureRequest) => T;
    unboundResolution: (request: SkillUnboundResolutionRequest) => T;
    detachment: (request: SkillDetachmentRequest) => T;
  }>,
): T {
  if (request.choice === "adopt-exact") return handlers.adoptExact(request);
  if (request.choice === "keep-variant") return handlers.variantCapture(request);
  if (request.choice === "link-canonical") return handlers.unboundResolution(request);
  if (request.choice === "detach-managed") return handlers.detachment(request);
  if (request.choice === "keep-local" || request.choice === "use-canonical") return handlers.managedResolution(request);
  throw new Error("Skill reconciliation request has no explicit dispatch route.");
}
