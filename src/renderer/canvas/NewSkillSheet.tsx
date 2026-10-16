import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { AgentStatus } from "../../shared/agents-ipc";
import { useI18n } from "../i18n";
import { SheetFrame } from "./SheetFrame";
import { Glossary } from "./Glossary";
import { PluginPicker, type PluginSelection } from "./PluginPicker";
import { usePersonalMarketplace } from "./use-personal-marketplace";
import { useCanvasToast } from "./CanvasToast";
import { harnessLabel } from "./project-view-model";
import { checkNewSkill, newSkillPrompt, newSkillRequest } from "./new-skill-model";
import { useNewSkillCreation } from "./use-new-skill-creation";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import "./new-skill.css";

export function NewSkillSheet(
  props: Readonly<{
    canvas: ResourceCanvasProps;
    initialProjectId?: string;
    initialPackageId?: string;
    onClose: () => void;
    onApplyingChange: (busy: boolean) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const toast = useCanvasToast();
  const { marketplace, error: readError, loading } = usePersonalMarketplace(props.canvas);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(t("newSkill.bodyTemplate"));
  const [selection, setSelection] = useState<PluginSelection>(
    props.initialPackageId ? { kind: "existing", packageId: props.initialPackageId } : { kind: "none" },
  );
  const [projects, setProjects] = useState<readonly string[]>(props.initialProjectId ? [props.initialProjectId] : []);
  const [mode, setMode] = useState<"agent" | "here">("agent");
  const [agent, setAgent] = useState<"claude-code" | "codex">("claude-code");
  const [agents, setAgents] = useState<AgentStatus["harnesses"]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const copyingRef = useRef(false);
  const notified = useRef(false);
  useEffect(() => {
    let current = true;
    const api = props.canvas.railServices?.api ?? props.canvas.api;
    if (api?.getAgentStatus)
      void api
        .getAgentStatus()
        .then((status) => {
          if (!current) return;
          setAgents(status.harnesses);
          const connected = status.harnesses.find((harness) => harness.registered && harness.detected);
          if (connected) setAgent(connected.harness);
        })
        .catch((error: unknown) => {
          if (current) setAgentError(error instanceof Error ? error.message : t("projectView.operationFailed"));
        });
    return () => {
      current = false;
    };
  }, [props.canvas.api, props.canvas.railServices?.api, t]);
  const availableProjects = props.canvas.snapshot.registry.projects.filter((project) => !project.archivedAt);
  const targets = availableProjects
    .filter((project) => projects.includes(project.ref.id))
    .map((project) => ({ id: project.ref.id, name: project.displayName }));
  const plugins = marketplace?.plugins ?? [];
  const draft = useMemo(() => ({ name, description, body, selection }), [name, description, body, selection]);
  const checks = checkNewSkill(draft, plugins, Boolean(marketplace?.inventory && !loading && !readError));
  const ready = checks.every(Boolean) && Boolean(body.trim());
  const request = useMemo(
    () => (ready && marketplace && mode === "here" ? newSkillRequest(draft, marketplace.source.ref.id) : null),
    [ready, draft, marketplace?.source.ref.id, mode],
  );
  const pluginName =
    selection.kind === "new"
      ? selection.name
      : selection.kind === "existing"
        ? (plugins.find((plugin) => plugin.id === selection.packageId)?.name ?? selection.packageId.split("/").at(-1)!)
        : "";
  const creation = useNewSkillCreation({
    canvas: props.canvas,
    request,
    targets,
    pluginName,
    onApplyingChange: props.onApplyingChange,
  });
  const disabled = creation.busy || creation.created;
  const prompt = newSkillPrompt(
    draft,
    plugins,
    targets.map((project) => project.name),
    t,
  );
  useEffect(() => {
    if (!creation.complete || creation.busy || notified.current) return;
    notified.current = true;
    props.onClose();
    toast.show({
      message: creation.complete,
      undo: async () => {
        try {
          await creation.undo();
          toast.show({ message: t("projectView.undone") });
        } catch (error) {
          toast.show({ message: error instanceof Error ? error.message : t("projectView.operationFailed") });
        }
      },
    });
  }, [creation.complete, creation.busy]);
  async function copy(): Promise<void> {
    if (copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(prompt);
      props.onClose();
      toast.show({ message: t("newSkill.copied", { agent: harnessLabel(agent) }) });
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : t("projectView.operationFailed"));
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  }
  const checkLabels = [
    t("newSkill.nameCheck"),
    t("newSkill.freeCheck"),
    t("newSkill.triggerCheck"),
    t("newSkill.lengthCheck", { count: description.length }),
    t("newSkill.pluginCheck"),
  ];
  return (
    <SheetFrame
      title={t("newSkill.title")}
      subtitle={t("newSkill.subtitle")}
      kicker={
        <>
          {t("addResource.kicker")} <Glossary concept="skill" />
        </>
      }
      testId="new-skill-sheet"
      className="new-skill-sheet"
      busy={creation.busy}
      onClose={props.onClose}
      footer={
        <>
          <span className="skill-footer-note">{t(mode === "agent" ? "newSkill.agentNote" : "newSkill.hereNote")}</span>
          <button
            className="canvas-secondary-button is-primary"
            type="button"
            disabled={
              mode === "agent"
                ? copying
                : creation.busy ||
                  creation.previewing ||
                  (!creation.created && (!ready || !creation.plan || Boolean(creation.error)))
            }
            onClick={() => void (mode === "agent" ? copy() : creation.apply())}
          >
            {t(mode === "agent" ? "newSkill.copy" : creation.created ? "newSkill.retry" : "newSkill.create")}
          </button>
        </>
      }
    >
      <div className="skill-field">
        <label className="skill-label" htmlFor="ns-name">
          {t("newSkill.name")}
        </label>
        <input
          className="skill-input"
          id="ns-name"
          placeholder={t("newSkill.namePlaceholder")}
          value={name}
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
        <span className="skill-hint">{t("newSkill.nameHint")}</span>
      </div>
      <div className="skill-field">
        <label className="skill-label" htmlFor="ns-desc">
          {t("newSkill.description")}
        </label>
        <textarea
          className="skill-input skill-area"
          id="ns-desc"
          placeholder={t("newSkill.descriptionPlaceholder")}
          value={description}
          disabled={disabled}
          onChange={(event) => setDescription(event.target.value)}
        />
        <span className="skill-hint">{t("newSkill.descriptionHint")}</span>
      </div>
      <div className="skill-field">
        <span className="skill-label">
          {t("newSkill.store")} <Glossary concept="plugin" />
        </span>
        <PluginPicker
          plugins={plugins}
          selection={selection}
          onChange={setSelection}
          busy={disabled}
          loading={loading}
        />
      </div>
      <div className="skill-field">
        <span className="skill-label">{t("newSkill.projects")}</span>
        <div className="new-skill-projects">
          {availableProjects.map((project) => (
            <label className="new-skill-project" key={project.ref.id}>
              <input
                type="checkbox"
                data-ns-project={project.ref.id}
                checked={projects.includes(project.ref.id)}
                disabled={disabled || project.availability !== "available"}
                onChange={() =>
                  setProjects((current) =>
                    current.includes(project.ref.id)
                      ? current.filter((id) => id !== project.ref.id)
                      : [...current, project.ref.id],
                  )
                }
              />
              <span>
                {project.displayName} <small>{t("newSkill.projectAgents")}</small>
              </span>
            </label>
          ))}
        </div>
        <span className="skill-hint">{t("newSkill.projectsHint")}</span>
      </div>
      <div className="skill-field">
        <span className="skill-label">{t("newSkill.author")}</span>
        <div className="new-skill-segment">
          {(["agent", "here"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={mode === value}
              disabled={disabled}
              onClick={() => setMode(value)}
            >
              {t(`newSkill.${value}`)}
            </button>
          ))}
        </div>
      </div>
      {mode === "agent" ? (
        <>
          <div className="skill-field">
            <span className="skill-label">{t("newSkill.whichAgent")}</span>
            <div className="new-skill-segment new-skill-agents">
              {(["claude-code", "codex"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={agent === value}
                  disabled={
                    !agents.some((harness) => harness.harness === value && harness.registered && harness.detected)
                  }
                  onClick={() => setAgent(value)}
                >
                  {harnessLabel(value)}
                </button>
              ))}
            </div>
            <span className="skill-hint">
              {t(
                agents.filter((harness) => harness.registered && harness.detected).length === 2
                  ? "newSkill.bothConnected"
                  : "newSkill.connectHint",
              )}
            </span>
          </div>
          <div className="skill-field">
            <span className="skill-label">{t("newSkill.message", { agent: harnessLabel(agent) })}</span>
            <div className="new-skill-prompt">{prompt}</div>
            <span className="skill-hint">{t("newSkill.agentHint")}</span>
          </div>
        </>
      ) : (
        <div className="skill-field">
          <label className="skill-label" htmlFor="ns-body">
            {t("newSkill.body")}
          </label>
          <textarea
            className="skill-input skill-area is-code"
            id="ns-body"
            value={body}
            disabled={disabled}
            onChange={(event) => setBody(event.target.value)}
          />
          <ul className="new-skill-checks" aria-live="polite">
            {checks.map((ok, index) => (
              <li key={index} className={ok ? "" : "is-failed"}>
                {ok ? "✓" : "•"} {checkLabels[index]}
              </li>
            ))}
          </ul>
          {creation.plan?.findings?.length ? (
            <ul className="new-skill-findings">
              {creation.plan.findings.map((finding) => (
                <li key={`${finding.code}:${finding.message}`}>{finding.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {[readError, agentError, copyError, creation.error].filter(Boolean).map((error, index) => (
        <p className="skill-error" role="alert" key={index}>
          {error}
        </p>
      ))}
      {!marketplace && !loading ? (
        <p className="skill-error" role="alert">
          {t("skillActions.marketplaceUnavailable")}
        </p>
      ) : null}
    </SheetFrame>
  );
}
