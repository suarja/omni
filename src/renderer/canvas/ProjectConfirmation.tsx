import { useEffect, useRef, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { AnchoredFloating } from "./AnchoredFloating";
import { Glossary } from "./Glossary";
import { harnessLabel, projectHarnesses } from "./project-view-model";
import type { ProjectConfirmation as Confirmation } from "./use-project-operations";

export function ProjectConfirmation(
  props: Readonly<{
    selection: Confirmation;
    projectName: string;
    busy: boolean;
    error: string | null;
    onConfirm: () => void;
    onCancel: () => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const cancel = useRef<HTMLButtonElement>(null);
  const { row, action, harness, preview } = props.selection;
  useEffect(() => {
    if (!props.busy) cancel.current?.focus();
  }, [props.busy]);
  const agents = (
    harness
      ? [harness]
      : projectHarnesses.filter((agent) => row.agents[agent].state === (action === "enable" ? "disabled" : "installed"))
  )
    .map(harnessLabel)
    .join(" / ");
  const removing = action === "remove-agent";
  const agent = harnessLabel(harness ?? "claude-code");
  const other = harnessLabel(harness === "codex" ? "claude-code" : "codex");
  const last = Object.values(row.agents).filter((agent) => agent.state === "installed").length === 1;
  const title = removing
    ? t("skillActions.removeTitle", { name: row.name, agent, project: props.projectName })
    : t(`projectView.${action}Title`, { name: row.name, project: props.projectName });
  return (
    <AnchoredFloating
      anchor={props.selection.anchor}
      kind="pop"
      className="project-confirmation"
      testId="project-confirmation"
      label={title}
      busy={props.busy}
      onClose={props.onCancel}
    >
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            props.onCancel();
          }
          if (event.key === "Tab") {
            const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            if (event.shiftKey && document.activeElement === controls[0]) {
              event.preventDefault();
              controls.at(-1)?.focus();
            } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
              event.preventDefault();
              controls[0]?.focus();
            }
          }
        }}
      >
        <h3 id="project-confirm-title">
          {title} {!removing ? <Glossary concept={action === "enable" ? "disable" : action} /> : null}
        </h3>
        <p>
          {removing
            ? t(last ? "skillActions.removeLastCopy" : "skillActions.removeCopy", {
                agent,
                other,
                project: props.projectName,
              })
            : t(`projectView.${action}Copy`, { agents })}
        </p>
        {action === "delete" ? (
          <p>
            {row.origin.kind === "mine"
              ? t("projectView.keepMine")
              : row.origin.kind === "external"
                ? t("projectView.keepExternal", { source: row.origin.source })
                : t("projectView.keepLocal")}
          </p>
        ) : null}
        {preview && preview.status !== "ready" ? (
          <p role="alert">
            {preview.reason}
            {preview.details.map((detail) => (
              <span key={`${detail.code}:${detail.relativePath}`}>
                {detail.relativePath} · {detail.message}
              </span>
            ))}
          </p>
        ) : null}
        {props.error ? <p role="alert">{props.error}</p> : null}
        <div className="project-sheet-actions">
          <button
            type="button"
            className="canvas-secondary-button"
            ref={cancel}
            disabled={props.busy}
            onClick={props.onCancel}
          >
            {t("projectView.cancel")}
          </button>
          <button
            type="button"
            className="canvas-secondary-button is-primary"
            disabled={props.busy || preview?.status !== "ready"}
            onClick={props.onConfirm}
          >
            {removing
              ? t("skillActions.removeAgent", { agent })
              : t(`projectView.${action === "delete" ? "deleteAction" : action}`)}
          </button>
        </div>
      </div>
    </AnchoredFloating>
  );
}
