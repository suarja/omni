import type { ReactElement } from "react";
import { useI18n } from "../i18n";

export function ProjectLegend(): ReactElement {
  const { t } = useI18n();
  return (
    <div className="project-legend">
      <span className="project-chip is-installed">✓ Claude Code</span>
      {t("projectView.installed")}
      <span className="project-chip is-absent">+ Codex</span>
      {t("projectView.absent")}
      <span className="project-chip is-update">{t("projectView.update")}</span>
      <span className="project-chip is-modified">{t("projectView.modified")}</span>
      <span className="project-chip is-removed">{t("externalLibrary.removed")}</span>
    </div>
  );
}
