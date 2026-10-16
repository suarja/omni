import { countInspectedSkills, inspectAgentEvidence } from "./project-inspection-view-model";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n, tCount } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { projectInstructions } from "../project-view-model";
import { parseProjectInspectionResponse, type InspectedProject } from "../../../shared/project-inspection-ipc";
import type { WorkspaceSetupActions, WorkspaceSetupState } from "./use-workspace-setup";
import type { WorkspaceSetupInputs } from "./workspace-setup-types";
import "../new-skill.css";
import "./add-resource.css";

export function AddProjectSheet(
  props: Readonly<{
    setup: WorkspaceSetupInputs;
    state: WorkspaceSetupState;
    actions: WorkspaceSetupActions;
    onClose: () => void;
  }>,
): ReactElement {
  const { t, language } = useI18n();
  const [inspection, setInspection] = useState<InspectedProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const locked = useRef(false),
    revision = useRef(0);
  useEffect(() => {
    cancel.current?.focus();
    return () => {
      revision.current += 1;
    };
  }, []);
  async function inspect(): Promise<void> {
    if (locked.current || !props.setup.api?.inspectProject) return;
    const ticket = ++revision.current;
    locked.current = true;
    setBusy(true);
    setError(null);
    setInspection(null);
    try {
      const result = parseProjectInspectionResponse(await props.setup.api.inspectProject());
      if (ticket !== revision.current) return;
      if (result.status === "inspected") setInspection(result);
      else if (result.status === "inaccessible") setError(result.diagnostic);
    } catch (error) {
      if (ticket === revision.current)
        setError(error instanceof Error ? error.message : t("canvasSetup.registrationFailed"));
    } finally {
      locked.current = false;
      if (ticket === revision.current) setBusy(false);
    }
  }
  const inventory = inspection?.inventory;
  const git = inventory?.gitScopes ?? [];
  const instructions = projectInstructions(inventory);
  const skillCount = countInspectedSkills(inventory);
  const agents = inspectAgentEvidence(inventory);
  return (
    <SheetFrame
      title={t("addResource.project")}
      kicker={
        <>
          {t("addResource.kicker")} <Glossary concept="project" />
        </>
      }
      testId="canvas-setup-sheet"
      className="add-resource-sheet"
      onClose={props.onClose}
      busy={props.state.busy}
      focusClose={false}
      footer={
        <>
          <button
            ref={cancel}
            className="canvas-secondary-button"
            type="button"
            disabled={props.state.busy}
            onClick={props.onClose}
          >
            {t("addResource.cancel")}
          </button>
          <span className="skill-footer-note" />
          <button
            className="canvas-secondary-button is-primary"
            type="button"
            disabled={busy || props.state.busy || !inspection || props.setup.registryBusy}
            data-testid="canvas-setup-register-project"
            onClick={() => void props.actions.registerProject(inspection!.grantHandle)}
          >
            {t("addResource.addProject")}
          </button>
        </>
      }
    >
      <div className="skill-field">
        <span className="skill-label">{t("addResource.folder")}</span>
        <div className="add-resource-stack">
          <button
            className="canvas-secondary-button"
            data-testid="canvas-setup-inspect-project"
            type="button"
            disabled={busy || !props.setup.api?.inspectProject}
            onClick={() => void inspect()}
          >
            {t("addResource.choose")}
          </button>
          <span className="add-resource-copy">{inspection?.displayRoot ?? t("addResource.none")}</span>
        </div>
      </div>
      {inspection ? (
        <>
          <section className="project-sheet-section">
            <h3>{t("addResource.found")}</h3>
            <dl className="add-resource-kv">
              <dt>{t("addResource.name")}</dt>
              <dd>{inspection.displayName}</dd>
              <dt>{t("addResource.git")}</dt>
              <dd>
                {git.length
                  ? git
                      .map((scope) =>
                        t("addResource.branch", {
                          branch: scope.branch ?? t("addResource.unknown"),
                          state: t(
                            scope.dirty === true
                              ? "addResource.dirty"
                              : scope.dirty === false
                                ? "addResource.clean"
                                : "addResource.unknown",
                          ),
                        }),
                      )
                      .join(" · ")
                  : t("addResource.notFound")}
              </dd>
              <dt>{t("addResource.agents")}</dt>
              <dd>
                {agents.length
                  ? agents
                      .map((agent) =>
                        agent.path
                          ? t("addResource.agentEvidence", { agent: agent.label, evidence: agent.path })
                          : agent.label,
                      )
                      .join(" · ")
                  : t("addResource.notFound")}
              </dd>
              <dt>{t("addResource.skills")}</dt>
              <dd>{tCount("addResource.skillCount", skillCount, {}, language)}</dd>
              <dt>{t("addResource.instructions")}</dt>
              <dd>
                {instructions.length
                  ? instructions
                      .map((item) =>
                        item.aliases.length
                          ? t("addResource.alias", { path: item.path, aliases: item.aliases.join(", ") })
                          : item.path,
                      )
                      .join(" · ")
                  : t("addResource.notFound")}
              </dd>
            </dl>
          </section>
          <p className="add-resource-copy">{t("addResource.readOnly")}</p>
        </>
      ) : (
        <p className="add-resource-copy">{t("addResource.projectHint")}</p>
      )}
      {inventory?.diagnostics.map((diagnostic) => (
        <p className="skill-error" key={`${diagnostic.location}:${diagnostic.code}`}>
          {diagnostic.location}: {diagnostic.message}
        </p>
      ))}
      {error || props.state.error ? (
        <p className="skill-error" role="alert">
          {error ?? props.state.error}
        </p>
      ) : null}
      {props.state.refreshAvailable ? (
        <button
          className="canvas-secondary-button"
          data-testid="canvas-setup-refresh-conflict"
          disabled={props.state.refreshing}
          onClick={() => void props.actions.refreshWorkspace()}
        >
          {t("canvasSetup.refreshWorkspace")}
        </button>
      ) : null}
    </SheetFrame>
  );
}
