import type { ReactElement } from "react";
import type { SkillIntent, SkillPreview } from "../../../shared/skill-management-ipc";
import type { TranslationFunction } from "../../i18n";
import type { reconciliationModes } from "./reconciliation-mode";

export function WorkbenchActions({
  preview,
  modes,
  busy,
  applying,
  intent,
  restoreMode,
  propagationRestore,
  removalMode,
  detachmentRestoreMode,
  t,
  onBack,
  onCancelRestore,
  refresh,
  apply,
}: Readonly<{
  preview: SkillPreview;
  modes: ReturnType<typeof reconciliationModes>;
  busy: boolean;
  applying: boolean;
  intent: SkillIntent | null;
  restoreMode: boolean;
  propagationRestore: boolean;
  removalMode: boolean;
  detachmentRestoreMode: boolean;
  t: TranslationFunction;
  onBack?: () => void;
  onCancelRestore?: () => void;
  refresh: () => Promise<SkillPreview | null>;
  apply: () => Promise<void>;
}>): ReactElement {
  return (
    <div className="changes-actions">
      {onBack ? (
        <button className="changes-secondary" disabled={busy} onClick={onBack} type="button">
          {t("skillManagement.backToCopies")}
        </button>
      ) : null}
      <span className="changes-note">
        {applying
          ? t("skillManagement.applying")
          : propagationRestore
            ? t("skillManagement.propagationRestoreScope")
            : preview.status === "ready" &&
                (modes.variantCapture ||
                  preview.steps.some((step) => step.variantCaptureEvidence) ||
                  !preview.scope.targets.length)
              ? t("skillManagement.sourceOnly")
              : t("skillManagement.targetOutcomes")}
      </span>
      {propagationRestore && onCancelRestore ? (
        <button className="changes-secondary" disabled={busy} onClick={onCancelRestore} type="button">
          {t("skillManagement.cancelRestore")}
        </button>
      ) : null}
      <button className="changes-secondary" disabled={busy} onClick={() => void refresh()} type="button">
        {t("skillManagement.refresh")}
      </button>
      <button
        className="changes-primary"
        disabled={preview.status !== "ready" || busy}
        onClick={() => void apply()}
        type="button"
      >
        {restoreMode
          ? t(detachmentRestoreMode ? "skillManagement.restoreManagement" : "skillManagement.restore")
          : removalMode
            ? t("skillManagement.remove")
            : modes.detachment
              ? t("skillManagement.confirmDetachment")
              : modes.exactAdoption
                ? t("skillManagement.confirmAdoption")
                : modes.canonicalLink
                  ? t("skillManagement.confirmCanonicalLink")
                  : modes.variantCapture
                    ? t("skillManagement.confirmVariantCapture")
                    : modes.managedResolution
                      ? t("skillManagement.confirmResolution")
                      : intent?.kind === "assign"
                        ? t("skillManagement.applyAssignment")
                        : t("skillManagement.apply")}
      </button>
    </div>
  );
}
