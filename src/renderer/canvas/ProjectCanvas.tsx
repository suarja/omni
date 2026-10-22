import { LoadingSkeleton } from "../components/ui/Skeleton";
import { AppUpdateRestartControl } from "../settings/AppUpdateRestartControl";
import { ProjectLegend } from "./ProjectLegend";
import { findRowUse } from "./external-library/presentation";
import { activeWorkshop } from "../../domain/source-roles";
import { NewSkillSheet } from "./NewSkillSheet";
import { useEmptyCanvasPress } from "./use-empty-canvas-press";
import { useCanvasToast } from "./CanvasToast";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { ProjectSkillRow } from "../../shared/project-skills-ipc";
import type { SkillIntent } from "../../shared/skill-management-ipc";
import { createResourceCatalogue } from "../../domain/resource-catalogue";
import { Icon } from "../components/Icon";
import { useI18n, translateCount } from "../i18n";
import { useCanvasRail } from "./rail/rail-context";
import { CanvasRail, CanvasAddButton } from "./rail/RailControls";
import { CanvasRailLayer } from "./rail/CanvasRailLayer";
import { CanvasSearch } from "./CanvasSearch";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { routeForResource } from "./canvas-navigation-utils";
import { Glossary } from "./Glossary";
import { ProjectGraph } from "./ProjectGraph";
import { ProjectSkillsSheet, type ProjectSheetTab } from "./ProjectSkillsSheet";
import { ProjectSkillSheet } from "./ProjectSkillSheet";
import { ProjectAddSkillsSheet, projectAssignmentChoices } from "./ProjectAddSkillsSheet";
import { ProjectCaptureSheet } from "./ProjectCaptureSheet";
import { ProjectConfirmation } from "./ProjectConfirmation";
import { buildProjectGraph } from "./project-graph-layout";
import {
  maintenanceIntent,
  originTitle,
  projectInstructions,
  projectInventory,
  installedProjectHarnesses,
} from "./project-view-model";
import { useProjectSkills } from "./use-project-skills";
import { useProjectOperations } from "./use-project-operations";
import { createCanvasSession } from "./spatial/canvas-session";
import { useCanvasCamera } from "./spatial/use-canvas-camera";
import { CanvasViewport } from "./spatial/CanvasViewport";
import { ChangesWorkbench } from "./changes/ChangesWorkbench";
import { useAssignmentChoices } from "./changes/use-assignment-choices";
import "./project-view.css";

const groupCamera = { x: 0, y: 0, scale: 1 };

type Sheet = "project" | "skill" | "add" | "capture" | "new-skill" | null;
export function ProjectCanvas(props: ResourceCanvasProps & Readonly<{ projectId: string }>): ReactElement {
  const { t } = useI18n();
  const rail = useCanvasRail();
  const toast = useCanvasToast();
  const { data, error: readError, reload } = useProjectSkills(props, props.projectId);
  const project = props.snapshot.registry.projects.find((project) => project.ref.id === props.projectId);
  const name = project?.displayName ?? props.projectId;
  const inventory = projectInventory(props.snapshot, props.projectId);
  const instructions = useMemo(() => projectInstructions(inventory), [inventory]);
  const catalogue = useMemo(() => createResourceCatalogue(props.snapshot), [props.snapshot]);
  const records = useMemo(() => catalogue.search(""), [catalogue]);
  const choices = useAssignmentChoices(props.snapshot, catalogue, records);
  const [localSession] = useState(createCanvasSession);
  const session = props.session ?? localSession;
  const sessionKey = `project-ux:${props.projectId}`;
  const [group, setGroup] = useState<ProjectSkillRow["origin"]["kind"] | null>(() => {
    const saved = session.read(sessionKey)?.groupId;
    return saved === "mine" || saved === "external" || saved === "project-only" ? saved : null;
  });
  const [sheet, setSheet] = useState<Sheet>(props.initialProjectSheet ?? null);
  useEffect(() => {
    if (props.initialProjectSheet) setSheet(props.initialProjectSheet);
  }, [props.initialProjectSheet]);
  const [tab, setTab] = useState<ProjectSheetTab>("skills");
  const [selectedRow, setSelectedRow] = useState<ProjectSkillRow | null>(null);
  const observedRow = data?.skills.find((row) => row.id === selectedRow?.id);
  const row = observedRow
    ? { ...observedRow, skillId: observedRow.skillId ?? selectedRow?.skillId }
    : data
      ? null
      : selectedRow;
  const [help, setHelp] = useState(false);
  const [search, setSearch] = useState(false);
  const [workbench, setWorkbench] = useState<SkillIntent | null>(null);
  const [workbenchApplying, setWorkbenchApplying] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  useEffect(() => {
    if (data && selectedRow && !observedRow && (sheet === "skill" || sheet === "capture")) {
      setSelectedRow(null);
      setSheet("project");
    }
  }, [data, observedRow, selectedRow, sheet]);
  const trigger = useRef<HTMLElement | null>(null);
  const afterChanged = useCallback(async (): Promise<void> => {
    await reload();
    props.onRefresh();
  }, [reload, props.onRefresh]);
  const operations = useProjectOperations({
    api: props.api,
    projectId: props.projectId,
    projectName: name,
    onChanged: afterChanged,
    onEnsureGrant: props.onEnsureGrant,
  });
  const busy = operations.busy || workbenchApplying || captureBusy;
  const undo = useRef(operations.undo);
  undo.current = operations.undo;
  useEffect(() => {
    if (operations.toast)
      toast.show({
        message: operations.toast.message,
        undo: operations.toast.operationIds.length ? () => undo.current() : undefined,
      });
  }, [operations.toast]);
  useEffect(() => {
    if (!operations.toast) return;
    toast.update({
      message: operations.toast?.message ?? "",
      undo: operations.toast?.operationIds.length ? () => undo.current() : undefined,
      disabled: busy || Boolean(operations.confirmation) || Boolean(workbench),
    });
  }, [busy, operations.confirmation, workbench]);
  const emptyPress = useEmptyCanvasPress(
    () => {
      if (rail?.surface || rail?.menuOpen) rail.close();
      else if (search || sheet) closeSheet();
    },
    busy || Boolean(workbench) || Boolean(operations.confirmation) || Boolean(props.routeSheet),
  );
  const model = useMemo(
    () =>
      buildProjectGraph(
        data,
        name,
        group,
        instructions,
        t,
        [...(rail?.externalLibrary.details.values() ?? [])].flatMap((details) => details.uses),
      ),
    [data, name, group, instructions, t, rail?.externalLibrary.details],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewKey = `${sessionKey}:${group ?? "overview"}`;
  const camera = useCanvasCamera({
    viewportRef,
    viewKey,
    layout: model.layout,
    layoutForSize: () => model.layout,
    initialCamera: session.read(sessionKey)?.cameras[viewKey] ?? (group ? groupCamera : undefined),
    resizeAnchor: group ? "origin" : "center",
    disabled: busy || Boolean(workbench),
    onCameraChange: (next) =>
      session.write(sessionKey, { groupId: group, cameras: { ...session.read(sessionKey)?.cameras, [viewKey]: next } }),
  });

  function rememberTrigger(): void {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  function openProject(nextTab: ProjectSheetTab = "skills"): void {
    if (busy) return;
    rememberTrigger();
    setTab(nextTab);
    setSheet("project");
    setSearch(false);
  }
  function closeSheet(): void {
    if (busy) return;
    setSheet(null);
    setSearch(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  function selectGroup(next: ProjectSkillRow["origin"]["kind"] | null): void {
    if (busy) return;
    setGroup(next);
    session.write(sessionKey, { groupId: next, cameras: session.read(sessionKey)?.cameras ?? {} });
  }
  function openSkill(row: ProjectSkillRow): void {
    if (busy) return;
    rememberTrigger();
    setSelectedRow(row);
    setSheet("skill");
  }
  async function openWorkbench(intent: SkillIntent): Promise<void> {
    if (busy) return;
    rememberTrigger();
    setCaptureBusy(true);
    setCaptureError(null);
    const sourceId =
      intent.kind === "maintain-current"
        ? intent.source.sourceId
        : intent.kind === "reconcile" && intent.request.choice === "keep-variant"
          ? intent.request.destination.sourceId
          : undefined;
    try {
      if (sourceId && !(await props.onEnsureGrant({ kind: "source", id: sourceId })))
        throw new Error(t("projectView.operationUnavailable"));
      setWorkbench(intent);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : t("projectView.operationFailed"));
    } finally {
      setCaptureBusy(false);
    }
  }
  function update(row: ProjectSkillRow): void {
    const use = findRowUse(
      [...(rail?.externalLibrary.details.values() ?? [])].flatMap((details) => details.uses),
      row,
      props.projectId,
    );
    if (use) {
      rail?.openExternalDestination({
        sourceId: use.sourceId,
        skillName: use.skillKey,
        useId: use.id,
        view: "compare",
      });
      return;
    }
    const intent = maintenanceIntent(props.projectId, row);
    if (intent) void openWorkbench(intent);
  }
  async function capture(row: ProjectSkillRow): Promise<void> {
    if (busy) return;
    rememberTrigger();
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      setSelectedRow(row);
      setSheet("capture");
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : t("projectView.operationFailed"));
    } finally {
      setCaptureBusy(false);
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || busy || rail?.overlayOpen || rail?.menuOpen) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        rememberTrigger();
        setSearch(true);
      }
      if (event.key === "Escape" && !workbench) {
        if (operations.confirmation) operations.cancel();
        else if (search || sheet) closeSheet();
        else if (group) selectGroup(null);
      }
      if ((event.altKey && event.key === "ArrowRight") || (event.metaKey && event.key === "]")) {
        if (workbench || operations.confirmation || sheet || search) return;
        event.preventDefault();
        props.onForward?.();
      }
      if ((event.altKey && event.key === "ArrowLeft") || (event.metaKey && event.key === "[")) {
        if (workbench || operations.confirmation) return;
        event.preventDefault();
        if (sheet || search) closeSheet();
        else if (group) selectGroup(null);
        else props.onBack?.();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    busy,
    group,
    operations.confirmation,
    search,
    sheet,
    workbench,
    props.onBack,
    props.onForward,
    rail?.overlayOpen,
    rail?.menuOpen,
  ]);
  function openNode(id: string): void {
    if (id === "mine" || id === "external" || id === "project-only") selectGroup(id);
    else openProject(id.startsWith("instructions:") ? "instructions" : "skills");
  }
  return (
    <div
      className={`resource-canvas${help ? " is-help-mode" : ""}`}
      data-theme="light"
      data-testid="resource-canvas"
      aria-busy={busy}
    >
      <CanvasRail busy={busy || Boolean(workbench) || Boolean(operations.confirmation) || Boolean(props.routeSheet)} />
      <header
        className="canvas-header"
        inert={busy || Boolean(workbench) || Boolean(operations.confirmation) || Boolean(props.routeSheet)}
      >
        <nav className="canvas-breadcrumbs" aria-label={t("canvas.breadcrumbs")}>
          <button
            type="button"
            onClick={() => props.onNavigate({ screen: "resource-canvas", context: { kind: "workspace" } })}
          >
            {t("canvas.workspace")}
          </button>
          <span>/</span>
          <button type="button" onClick={() => selectGroup(null)}>
            {name}
          </button>
          {group ? (
            <>
              <span>/</span>
              <span>{originTitle(group, t)}</span>
            </>
          ) : null}
        </nav>
        <div className="canvas-header-actions">
          <button
            type="button"
            className="canvas-search-trigger"
            onClick={() => {
              rememberTrigger();
              setSearch(true);
            }}
          >
            <Icon name="search" size={16} />
            <span>{t("canvas.search")}</span>
            <kbd>⌘K</kbd>
          </button>
          <CanvasAddButton />
          <button type="button" className="canvas-secondary-button" aria-pressed={help} onClick={() => setHelp(!help)}>
            {t("projectView.help")}
          </button>
          <AppUpdateRestartControl api={props.railServices?.api ?? props.api} />
          <button
            type="button"
            className="canvas-icon-button"
            aria-label={t("canvas.refresh")}
            onClick={() => void afterChanged()}
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </header>
      <main
        {...emptyPress}
        className="canvas-stage"
        inert={busy || Boolean(workbench) || Boolean(operations.confirmation)}
      >
        <div className="project-stage-heading">
          <strong className="stage-title">{group ? originTitle(group, t) : name}</strong>{" "}
          <Glossary
            concept={
              group === "mine"
                ? "mine"
                : group === "external"
                  ? "external"
                  : group === "project-only"
                    ? "local"
                    : "project"
            }
          />
          <span className="stage-note">
            {data ? (
              translateCount(
                t,
                group ? "canvas.groupNote" : "canvas.projectNote",
                group ? data.skills.filter((row) => row.origin.kind === group).length : data.skills.length,
              )
            ) : readError ? (
              t("canvas.unavailable")
            ) : (
              <LoadingSkeleton label={t("projectView.loading")} variant="inline" />
            )}
          </span>
          {!group ? (
            <button
              type="button"
              data-testid="project-manage-skills"
              className="canvas-secondary-button is-small is-primary"
              onClick={() => openProject()}
            >
              {t("projectView.manage")}
            </button>
          ) : null}
        </div>
        <CanvasViewport viewportRef={viewportRef} controls={camera} disabled={busy || Boolean(workbench)}>
          <ProjectGraph
            model={model}
            readState={data ? "ready" : readError ? "unavailable" : "loading"}
            agents={installedProjectHarnesses(inventory, data)}
            onNode={openNode}
            onSkill={openSkill}
            busy={busy}
            onToggleAgent={(row, harness) => void operations.toggleAgent(row, harness)}
          />
        </CanvasViewport>
        {group ? <ProjectLegend /> : null}
      </main>
      {(props.diagnostic || readError || captureError || operations.error) && !operations.confirmation ? (
        <div className="project-error" role="alert">
          {props.diagnostic ??
            (readError ? `${t("projectView.unavailable")} ${readError}` : (captureError ?? operations.error))}
        </div>
      ) : null}
      <div
        className="project-sheet-layer"
        inert={Boolean(operations.confirmation) || Boolean(workbench) || captureBusy || rail?.overlayOpen}
      >
        {sheet === "project" ? (
          <ProjectSkillsSheet
            canvas={props}
            projectId={props.projectId}
            projectName={name}
            data={data}
            instructions={instructions}
            tab={tab}
            onTab={setTab}
            onClose={closeSheet}
            onOpenSkill={openSkill}
            onAdd={() => setSheet("add")}
            onUpdate={update}
            onCapture={(row) => void capture(row)}
            operations={operations}
          />
        ) : null}
        {sheet === "skill" && row ? (
          <ProjectSkillSheet
            key={row.id}
            canvas={props}
            projectId={props.projectId}
            projectName={name}
            row={row}
            onClose={closeSheet}
            onUpdate={() => update(row)}
            onCapture={() => void capture(row)}
            operations={operations}
          />
        ) : null}
        {sheet === "add" ? (
          <ProjectAddSkillsSheet
            projectId={props.projectId}
            projectName={name}
            choices={projectAssignmentChoices(props, choices.artifacts, data)}
            busy={busy}
            onClose={() => setSheet("project")}
            onNewSkill={() => setSheet("new-skill")}
            onApply={(intents) => void operations.runIntents(intents, t("projectView.completed"))}
          />
        ) : null}
        {sheet === "new-skill" ? (
          <NewSkillSheet
            canvas={props}
            initialProjectId={props.projectId}
            onClose={closeSheet}
            onApplyingChange={setCaptureBusy}
          />
        ) : null}
        {sheet === "capture" && row ? (
          <ProjectCaptureSheet
            canvas={props}
            projectId={props.projectId}
            projectName={name}
            row={row}
            onClose={() => setSheet("skill")}
            onApplyingChange={setCaptureBusy}
            onApplied={(receipt, message) => {
              operations.recordOperations([receipt.operationId], message);
              if (receipt.status === "applied") setSheet("skill");
              void afterChanged();
            }}
          />
        ) : null}
      </div>
      {search ? (
        <CanvasSearch
          records={records}
          onClose={closeSheet}
          onSelect={(resource) => props.onNavigate(routeForResource(resource.ref))}
        />
      ) : null}
      {operations.confirmation ? (
        <ProjectConfirmation
          selection={operations.confirmation}
          projectName={operations.confirmation.projectName}
          busy={operations.busy}
          error={operations.error}
          onConfirm={() => void operations.confirm()}
          onCancel={operations.cancel}
        />
      ) : null}
      {workbench ? (
        <ChangesWorkbench
          key={JSON.stringify(workbench)}
          api={props.api}
          initialSkillIntent={workbench}
          initialJourney="assign"
          initialProjectId={props.projectId}
          projects={choices.projects}
          packages={choices.packages}
          artifacts={choices.artifacts}
          sources={[activeWorkshop(props.snapshot.registry)]
            .filter((source) => source !== undefined)
            .map((source) => ({ id: source.ref.id, name: source.displayName }))}
          onClose={() => {
            if (!busy) {
              setWorkbench(null);
              requestAnimationFrame(() => trigger.current?.focus());
            }
          }}
          onSourceChanged={() => void afterChanged()}
          onApplyingChange={setWorkbenchApplying}
          onResult={(result) => operations.recordResult(result, t("projectView.completed"))}
        />
      ) : null}
      <CanvasRailLayer
        busy={busy || Boolean(workbench) || Boolean(operations.confirmation)}
        onApplyingChange={setWorkbenchApplying}
      />
    </div>
  );
}
