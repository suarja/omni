import { useEffect, useState, type ReactElement } from "react";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { isActiveAvailableProject } from "./active-projects";

export function InlineSkillInstall(
  props: Readonly<{
    installedProjectIds: readonly string[];
    onInstall: (projectIds: readonly string[]) => void;
    disabled?: boolean;
    preparing?: boolean;
    onSelectionChange?: (projectIds: readonly string[]) => void;
  }>,
): ReactElement {
  const rail = useCanvasRail()!;
  const { t } = useI18n();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const projects = rail.canvas.snapshot.registry.projects.filter(isActiveAvailableProject);
  const eligible = new Set(
    projects
      .filter(
        (project) =>
          !props.disabled &&
          project.availability === "available" &&
          !props.installedProjectIds.includes(project.ref.id),
      )
      .map((project) => project.ref.id),
  );
  const currentSelection = selected.filter((id) => eligible.has(id));
  const selectionKey = JSON.stringify(currentSelection);
  useEffect(() => {
    setSelected((previous) => previous.filter((id) => eligible.has(id)));
    props.onSelectionChange?.(currentSelection);
  }, [selectionKey, props.onSelectionChange]);
  const names = projects
    .filter((project) => currentSelection.includes(project.ref.id))
    .map((project) => project.displayName);
  return (
    <section className="external-section">
      <h3>{t("externalLibrary.installInProject")}</h3>
      <div className="external-options">
        {projects.map((project) => {
          const installed = props.installedProjectIds.includes(project.ref.id);
          return (
            <label className="external-option" key={project.ref.id} data-project-id={project.ref.id}>
              <input
                type="checkbox"
                checked={installed || currentSelection.includes(project.ref.id)}
                disabled={installed || props.disabled || project.availability !== "available"}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...currentSelection, project.ref.id]
                    : currentSelection.filter((id) => id !== project.ref.id);
                  setSelected(next);
                  props.onSelectionChange?.(next);
                }}
              />
              <span>
                {project.displayName}{" "}
                <small>
                  ·{" "}
                  {installed
                    ? t("externalLibrary.alreadyInstalled")
                    : project.availability !== "available"
                      ? t("projectView.unavailable")
                      : t("externalLibrary.defaultAgents")}
                </small>
              </span>
            </label>
          );
        })}
      </div>
      {!projects.length ? <p>{t("externalLibrary.noProjectsYet")}</p> : null}
      {projects.some((project) => !props.installedProjectIds.includes(project.ref.id)) ? (
        <>
          <button
            type="button"
            className="canvas-secondary-button is-small is-primary"
            disabled={!currentSelection.length || props.preparing}
            aria-busy={props.preparing || undefined}
            onClick={() => {
              if (currentSelection.length) props.onInstall(currentSelection);
            }}
          >
            {t("externalLibrary.installIn", { projects: names.length ? names.join(", ") : "…" })}
          </button>
          {props.preparing ? (
            <p role="status" className="skill-hint">
              {t("externalLibrary.preparingAccess")}
            </p>
          ) : null}
          <p className="skill-hint">{t("externalLibrary.installGuardHint")}</p>
        </>
      ) : null}
    </section>
  );
}
