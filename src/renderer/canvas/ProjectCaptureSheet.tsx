import { parseExternalImportSource } from "../../shared/external-library-ui-ipc";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ProjectSkillRow } from "../../shared/project-skills-ipc";
import type { OperationPlan, OperationReceipt } from "../../shared/operations-ipc";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { useI18n } from "../i18n";
import { SheetFrame } from "./SheetFrame";
import { Glossary } from "./Glossary";
import { projectHarnesses } from "./project-view-model";
import { PluginPicker, pluginSelectionReady, type PluginSelection } from "./PluginPicker";
import { usePersonalMarketplace } from "./use-personal-marketplace";
import "./skill-actions.css";

export function ProjectCaptureSheet(
  props: Readonly<{
    canvas: ResourceCanvasProps;
    externalSource?: Readonly<{ sourceId: string; skillPath: string }>;
    selectedFolder?: string;
    projectId: string;
    projectName: string;
    row: ProjectSkillRow;
    onClose: () => void;
    onApplied: (receipt: OperationReceipt, message: string) => void;
    onApplyingChange: (busy: boolean) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const { marketplace, error: readError, loading } = usePersonalMarketplace(props.canvas);
  const [commitEnabled, setCommitEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    if (props.canvas.api?.getSettings)
      void props.canvas.api
        .getSettings()
        .then((settings) => {
          if (active) setCommitEnabled(settings.git.commitChanges);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [props.canvas.api]);
  const copy = props.row.origin.kind === "external";
  const [selection, setSelection] = useState<PluginSelection>({ kind: "none" });
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const locked = useRef(false);
  const folder =
    props.externalSource?.skillPath ??
    props.selectedFolder ??
    projectHarnesses
      .map((harness) => props.row.agents[harness])
      .find((agent) => agent.state === "installed" && agent.folderPath)?.folderPath;
  const selectedFolderUnavailable =
    props.selectedFolder !== undefined &&
    !projectHarnesses.some((harness) => {
      const agent = props.row.agents[harness];
      return agent.state === "installed" && agent.folderPath === props.selectedFolder;
    });
  const plugin =
    selection.kind === "existing"
      ? marketplace?.plugins.find((plugin) => plugin.id === selection.packageId)
      : undefined;
  const conflict = plugin?.skillNames.includes(props.row.name) ?? false;
  const ready =
    !loading &&
    !readError &&
    !selectedFolderUnavailable &&
    pluginSelectionReady(selection) &&
    Boolean(marketplace && folder) &&
    !conflict;
  useEffect(() => {
    let current = true;
    setPlan(null);
    setError(null);
    setPreviewing(false);
    if (!ready || !folder || selection.kind === "none") return;
    setPreviewing(true);
    void (async () => {
      if (!props.canvas.api?.previewOperation) throw new Error(t("projectView.operationUnavailable"));
      const external = props.externalSource;
      const prepared =
        external && props.canvas.api.prepareExternalSkillImport
          ? parseExternalImportSource(await props.canvas.api.prepareExternalSkillImport(external))
          : undefined;
      if (external && !prepared) throw new Error("External source copying is unavailable. Reopen the library.");
      const grantHandle =
        prepared?.grantHandle ?? (await props.canvas.onEnsureGrant({ kind: "project", id: props.projectId }));
      if (!grantHandle) throw new Error(t("projectView.operationUnavailable"));
      const result = await props.canvas.api.previewOperation({
        kind: "import-artifact",
        source: prepared
          ? { kind: prepared.kind, id: prepared.id, grantHandle }
          : { kind: "project", id: props.projectId, grantHandle },
        relativePath: prepared?.relativePath ?? folder,
        target:
          selection.kind === "existing"
            ? { packageId: selection.packageId }
            : { newPackageName: selection.name, description: selection.description },
      });
      if (!current) return;
      if (result.status === "ready") setPlan(result.plan);
      else setError(result.reason === "duplicate-logical-id" ? t("skillActions.conflict") : result.diagnostic);
    })()
      .catch((error: unknown) => {
        if (current) setError(error instanceof Error ? error.message : t("projectView.operationFailed"));
      })
      .finally(() => {
        if (current) setPreviewing(false);
      });
    return () => {
      current = false;
    };
  }, [selection, ready, folder, props.canvas.api, props.projectId, props.externalSource, t]);
  async function apply(): Promise<void> {
    if (locked.current || !plan || !props.canvas.api?.applyOperation) return;
    locked.current = true;
    setApplying(true);
    setError(null);
    props.onApplyingChange(true);
    try {
      const result = await props.canvas.api.applyOperation({ planId: plan.planId });
      if (result.status !== "applied") {
        setError(result.receipt.diagnostic ?? t("projectView.partial"));
        props.onApplied(result.receipt, t("projectView.partial"));
        return;
      }
      props.onApplied(
        result.receipt,
        t(copy ? "skillActions.copyToast" : "skillActions.captureToast", { name: props.row.name }),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : t("projectView.operationFailed"));
    } finally {
      locked.current = false;
      setApplying(false);
      props.onApplyingChange(false);
      setPlan(null);
    }
  }
  const intro = t(copy ? "skillActions.copyIntro" : "skillActions.captureIntro", {
    name: "{emphasis}",
    project: props.projectName,
    source: "{emphasis}",
  }).split("{emphasis}");
  const destination =
    selection.kind === "new"
      ? selection.name || t("skillActions.newPluginFallback")
      : (plugin?.name ?? t("skillActions.chosenPlugin"));
  const commitLabel = plan
    ? plan.git.mode === "commit"
      ? "skillActions.commit"
      : "skillActions.noCommit"
    : commitEnabled === null
      ? "skillActions.gitUnknown"
      : commitEnabled
        ? "skillActions.commit"
        : "skillActions.noCommit";
  return (
    <SheetFrame
      title={t(copy ? "skillActions.copy" : "projectView.capture")}
      kicker={
        <>
          {props.row.name} <Glossary concept={copy ? "copyext" : "capture"} />
        </>
      }
      testId="project-capture"
      className="skill-capture-sheet"
      busy={applying}
      onClose={props.onClose}
      footer={
        <>
          <button className="canvas-secondary-button" type="button" disabled={applying} onClick={props.onClose}>
            {t("projectView.back")}
          </button>
          <span className="skill-footer-note" />
          <button
            className="canvas-secondary-button is-primary"
            type="button"
            data-testid="project-capture-add"
            disabled={applying || previewing || !plan || !ready}
            onClick={() => void apply()}
          >
            {t(copy ? "skillActions.copyAction" : "skillActions.add")}
          </button>
        </>
      }
    >
      <p className="skill-capture-intro">
        {intro[0]}
        <b>{copy && props.row.origin.kind === "external" ? props.row.origin.source : props.row.name}</b>
        {intro[1]}
      </p>
      <div className="skill-field">
        <span className="skill-label">
          {t("skillActions.placeIn")} <Glossary concept="plugin" />
        </span>
        <PluginPicker
          plugins={marketplace?.plugins ?? []}
          selection={selection}
          onChange={setSelection}
          busy={applying || Boolean(readError)}
          loading={loading}
        />
      </div>
      {conflict || error || readError || selectedFolderUnavailable ? (
        <p role="alert" className="skill-error">
          {conflict
            ? t("skillActions.conflict")
            : selectedFolderUnavailable
              ? t("skillActions.selectedCopyUnavailable")
              : (error ?? readError)}
        </p>
      ) : null}
      {!marketplace ? (
        <p role="alert" className="skill-error">
          {t("skillManagement.noPersonalDestination")}
        </p>
      ) : null}
      <section className="project-sheet-section">
        <h3>{t("skillActions.changes")}</h3>
        <div className="skill-rows">
          <div className="skill-row">
            <div>
              <b>{marketplace?.source.displayName ?? t("projectView.marketplace")}</b>
              <small>
                {t(copy ? "skillActions.newFolder" : "skillActions.newSkill", {
                  name: props.row.name,
                  plugin: destination,
                })}{" "}
                · {t(commitLabel)}
              </small>
            </div>
          </div>
          <div className="skill-row">
            <div>
              <b>{props.projectName}</b>
              <small>
                {t(copy ? "skillActions.copiedProject" : "skillActions.capturedProject", {
                  source: props.row.origin.kind === "external" ? props.row.origin.source : "",
                })}
              </small>
            </div>
          </div>
        </div>
      </section>
    </SheetFrame>
  );
}
