import { useCanvasRail } from "./rail/rail-context";
import { findRowUse, useStateLabel } from "./external-library/presentation";
import type { ReactElement } from "react";
import type { ProjectSkillHarness, ProjectSkillRow } from "../../shared/project-skills-ipc";
import { useI18n } from "../i18n";
import { harnessLabel, isDisabledSkill, projectHarnesses } from "./project-view-model";

export function ProjectAgentChips({
  row,
  onToggle,
  busy,
}: Readonly<{
  row: ProjectSkillRow;
  busy?: boolean;
  onToggle?: (harness: ProjectSkillHarness) => void;
}>): ReactElement {
  const { t } = useI18n();
  return (
    <span className="project-agent-chips">
      {projectHarnesses.map((harness) => {
        const installed = row.agents[harness].state === "installed";
        const label = `${installed ? "✓" : "+"} ${harnessLabel(harness)}`;
        const className = `project-chip${installed ? " is-installed" : " is-absent"}`;
        const title = t(installed ? "skillActions.chipInstalled" : "skillActions.chipMissing", {
          agent: harnessLabel(harness),
        });
        return onToggle ? (
          <button
            type="button"
            className={className}
            key={harness}
            title={title}
            disabled={busy}
            aria-pressed={installed}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.focus();
              onToggle(harness);
            }}
          >
            {label}
          </button>
        ) : (
          <span className={className} key={harness} title={title}>
            {label}
          </span>
        );
      })}
    </span>
  );
}
export function ProjectSkillState({ row }: Readonly<{ row: ProjectSkillRow }>): ReactElement | null {
  const { t } = useI18n();
  const rail = useCanvasRail();
  const projectId =
    rail?.canvas.context.kind === "entry" && rail.canvas.context.entry.kind === "project"
      ? rail.canvas.context.entry.id
      : undefined;
  const use = findRowUse(
    [...(rail?.externalLibrary.details.values() ?? [])].flatMap((details) => details.uses),
    row,
    projectId,
  );
  if (!isDisabledSkill(row) && use && use.state !== "up-to-date")
    return (
      <span
        className={`project-chip is-${use.state === "modified" ? "modified" : use.state === "update" ? "update" : "removed"}`}
      >
        {useStateLabel(use, t)}
      </span>
    );
  const state = isDisabledSkill(row)
    ? "disabled"
    : row.state === "update-available"
      ? "update"
      : row.state === "modified-here"
        ? "modified"
        : row.state === "removed-upstream"
          ? "removed"
          : null;
  return state ? (
    <span className={`project-chip is-${state}`}>
      {state === "removed" ? t("externalLibrary.removed") : t(`projectView.${state}`)}
    </span>
  ) : null;
}
