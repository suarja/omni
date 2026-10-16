import type { SkillIntent } from "../../../shared/skill-management-ipc";
import type { TranslationKey } from "../../i18n";

export type ReconciliationModes = Readonly<{
  adoption: boolean;
  exactAdoption: boolean;
  canonicalLink: boolean;
  variantCapture: boolean;
  managedResolution: boolean;
  detachment: boolean;
}>;

export function reconciliationTitleKey(
  modes: ReconciliationModes,
  restoreMode: boolean,
  removalMode: boolean,
): TranslationKey {
  if (restoreMode) return "skillManagement.restoreReview";
  if (modes.detachment) return "skillManagement.detachmentReview";
  if (modes.variantCapture) return "skillManagement.variantCaptureReview";
  if (modes.canonicalLink) return "skillManagement.canonicalLinkReview";
  if (modes.managedResolution) return "skillManagement.resolutionReview";
  if (modes.exactAdoption) return "skillManagement.adoptionReview";
  if (removalMode) return "skillManagement.removeReview";
  return "skillManagement.title";
}

export function reconciliationModes(
  intent: SkillIntent | null,
  hasManagedSelection: boolean,
  variantSelected: boolean,
): ReconciliationModes {
  const choice = intent?.kind === "reconcile" ? intent.request.choice : undefined;
  return {
    adoption: intent?.kind === "reconcile",
    exactAdoption: choice === "adopt-exact",
    canonicalLink: choice === "link-canonical",
    variantCapture: choice === "keep-variant" || (hasManagedSelection && variantSelected),
    managedResolution: hasManagedSelection || choice === "keep-local" || choice === "use-canonical",
    detachment: choice === "detach-managed",
  };
}
