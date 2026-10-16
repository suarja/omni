import type { ReactElement } from "react";
import type { SkillPreview } from "../../../../shared/skill-management-ipc";
import type { TranslationFunction } from "../../../i18n";
import type { buildPropagationView } from "./view-model";
export function PropagationFooter({
  view,
  preview,
  busy,
  t,
  refresh,
  apply,
}: Readonly<{
  view: ReturnType<typeof buildPropagationView>;
  preview: SkillPreview | null;
  busy: boolean;
  t: TranslationFunction;
  refresh: () => Promise<SkillPreview | null>;
  apply: () => Promise<void>;
}>): ReactElement {
  return (
    <div className="changes-actions propagation-footer">
      <span className="changes-note">
        {t(
          view.sourceUpdate
            ? view.selectedProjectCount
              ? "skillManagement.propagationMarketplaceProjects"
              : "skillManagement.propagationMarketplaceOnly"
            : "skillManagement.propagationProjectsScope",
          { count: view.selectedProjectCount },
        )}
      </span>
      <button className="changes-secondary" disabled={busy || !preview} onClick={() => void refresh()} type="button">
        {t("skillManagement.refresh")}
      </button>
      <button
        className="changes-primary"
        disabled={preview?.status !== "ready" || busy || !view.canApply}
        onClick={() => void apply()}
        type="button"
      >
        {t(
          view.sourceUpdate
            ? view.selectedProjectCount
              ? "skillManagement.propagationUpdateSync"
              : "skillManagement.propagationUpdateSkill"
            : "skillManagement.propagationSyncProjects",
        )}
      </button>
    </div>
  );
}
