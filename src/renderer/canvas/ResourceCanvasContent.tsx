import { AppUpdateRestartControl } from "../settings/AppUpdateRestartControl";
import { projectExternalLibrary } from "./external-library/workspace";
import { activeWorkshop } from "../../domain/source-roles";
import { addWorkspaceUseRelations } from "./rail/workspace-relations";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { ProjectSkillGroup, ResourceRecord, ResourceRef } from "../../domain/resource-catalogue";
import { Icon } from "../components/Icon";
import { useI18n, type TranslationKey } from "../i18n";
import { useCanvasRail } from "./rail/rail-context";
import { CanvasRail, CanvasAddButton } from "./rail/RailControls";
import { CanvasRailLayer } from "./rail/CanvasRailLayer";
import { type Route } from "../navigation";
import { CanvasSearch } from "./CanvasSearch";
import { ResourceSheet } from "./ResourceSheet";
import { CanvasGroupSheet } from "./CanvasGroupSheet";
import { createResourceCatalogue } from "../../domain/resource-catalogue";
import { createCanvasSession } from "./spatial/canvas-session";
import { layoutCanvas } from "./spatial/canvas-layout";
import { useCanvasCamera } from "./spatial/use-canvas-camera";
import { useCanvasNavigation } from "./spatial/use-canvas-navigation";
import { displayGroupLabel } from "./spatial/canvas-labels";
import { CanvasStage } from "./CanvasStage";
import { createWorkspaceLayoutSession } from "./setup/workspace-layout-session";
import { type WorkspaceMapLayout } from "./setup/workspace-map-layout";
import type { WorkspaceMapIntent } from "./setup/WorkspaceSetupMap";
import "./canvas.css";
import "./setup/setup.css";
import { WorkspaceSetupSheet } from "./setup/WorkspaceSetupSheet";
import { useWorkspaceSetup } from "./setup/use-workspace-setup";
import { createFallbackWorkspaceSetup } from "./setup/fallback-workspace-setup";
import { useAssignmentChoices } from "./changes/use-assignment-choices";
import { CanvasOperationWorkbench } from "./CanvasOperationWorkbench";
import { useCanvasChanges } from "./use-canvas-changes";
import { useSkillCopies } from "./use-skill-copies";
import { useProjectSkillAttention } from "./use-project-skill-attention";
import { CanvasSkillCopiesLayer } from "./CanvasSkillCopiesLayer";
import { useSkillVariantNavigation } from "./skill-variant-navigation";
import { useSkillCopyPresentation } from "./use-skill-copy-presentation";
import { focusResourceNode, routeForResource } from "./canvas-navigation-utils";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import type { LogicalSkillNode } from "./spatial/spatial-types";

export type { ResourceCanvasProps } from "./resource-canvas-types";

export function ResourceCanvasContent(props: ResourceCanvasProps): ReactElement {
  const { t } = useI18n();
  const rail = useCanvasRail();
  if (!rail) throw new Error("Workspace canvas requires the canvas rail provider.");
  const [localSession] = useState(createCanvasSession);
  const session = props.session ?? localSession;
  const catalogue = useMemo(() => createResourceCatalogue(props.snapshot), [props.snapshot]);
  const listing = useMemo(() => catalogue.browse(props.context), [catalogue, props.context]);
  const contextEntry = props.context.kind === "workspace" ? null : props.context.entry;
  const projectId = props.context.kind === "entry" && contextEntry?.kind === "project" ? contextEntry.id : undefined;
  const projectGroups = useMemo(
    () => (projectId ? catalogue.projectSkillGroups({ kind: "project", id: projectId }) : []),
    [catalogue, projectId],
  );
  const projectEvidence = props.snapshot.roots.find(
    (root) => root.entry.kind === "project" && root.entry.id === projectId,
  )?.evidence;
  const projectRoots = useMemo(
    () =>
      props.snapshot.registry.projects
        .filter((project) => !project.archivedAt)
        .map((project) => ({
          projectId: project.ref.id,
          rootKey: JSON.stringify([project.displayRoot, project.availability]),
        })),
    [props.snapshot.registry.projects],
  );
  const rootKey = projectRoots.find((project) => project.projectId === projectId)?.rootKey;
  const evidenceObservationKey =
    projectEvidence?.status === "observed" ? projectEvidence.observation.observedAt : projectEvidence?.status;
  const observationKey = evidenceObservationKey ? JSON.stringify([evidenceObservationKey, rootKey ?? null]) : undefined;
  const skillCopies = useSkillCopies({
    projectId,
    groups: projectGroups,
    observationKey,
    api: props.api,
    onEnsureGrant: props.onEnsureGrant,
  });
  const attentionByProject = useProjectSkillAttention({
    projectId,
    roots: projectRoots,
    observationKey,
    observedAt: projectEvidence?.status === "observed" ? projectEvidence.observation.observedAt : undefined,
    skillCopies,
    session,
  });
  const allRecords = useMemo(() => catalogue.search(""), [catalogue]);
  const assignmentChoices = useAssignmentChoices(props.snapshot, catalogue, allRecords);
  const [help, setHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [setupApplying, setSetupApplying] = useState(false);
  const [copyManagementOpen, setCopyManagementOpen] = useState(false);
  const savedRouteId = props.initialSkillResultId ?? props.initialSkillRestoreOperationId;
  const [savedRouteResolution, setSavedRouteResolution] = useState<Readonly<{ id: string; handled: boolean }> | null>(
    null,
  );
  const savedRoutePending = Boolean(savedRouteId && savedRouteResolution?.id !== savedRouteId);
  const setupApplyingRef = useRef(false);
  const [infoRef, setInfoRef] = useState<ResourceRef | null>(null);
  const [groupInfoSelection, setGroupInfoSelection] = useState<Readonly<{ id: string; viewKey: string }> | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const copyManagementBack = useRef<() => void>(() => undefined);
  const copyManagementClose = useRef<() => void>(() => undefined);
  const searchButton = useRef<HTMLButtonElement>(null);
  const setupMenuButton = useRef<HTMLButtonElement>(null);
  const fallbackSetup = useMemo(() => createFallbackWorkspaceSetup(props.snapshot), [props.snapshot]);
  const setup = useWorkspaceSetup(props.setup ?? fallbackSetup, props.context);
  const workspaceMap = rail.workspaceMap;
  const mapVisible = props.context.kind === "workspace" && !workspaceMap.hidden && workspaceMap.progress.count < 3;
  const artifactRoute = props.context.kind === "artifact";
  const sheetRef = infoRef ?? (artifactRoute ? props.context : null);
  const details = sheetRef ? catalogue.inspect(sheetRef) : null;
  const baseNavigation = useCanvasNavigation({
    listing,
    catalogue,
    session,
    logicalCopies: skillCopies.status === "ready" ? skillCopies.byGroup : undefined,
    retainedSkills: skillCopies.status === "ready" ? skillCopies.retainedSkills : undefined,
    managedAttention: skillCopies.status === "ready" ? skillCopies.managedAttention : undefined,
    projectAttention: attentionByProject,
    isBlocked: () => setupApplyingRef.current,
  });
  const projection = useMemo(
    () =>
      props.context.kind === "workspace"
        ? rail?.externalLibrary.list
          ? projectExternalLibrary(
              addWorkspaceUseRelations(baseNavigation.projection, props.snapshot, rail?.uses ?? []),
              rail.externalLibrary.list.sources,
            )
          : projectExternalLibrary(
              addWorkspaceUseRelations(baseNavigation.projection, props.snapshot, rail?.uses ?? []),
              [],
            )
        : baseNavigation.projection,
    [props.context.kind, baseNavigation.projection, props.snapshot, rail?.uses, rail?.externalLibrary.list],
  );
  const navigation = { ...baseNavigation, projection };
  const copyNodes = useMemo(
    () =>
      navigation.projection.groups.flatMap((group) =>
        group.children.filter((child): child is LogicalSkillNode => child.kind === "logical-skill"),
      ),
    [navigation.projection.groups],
  );
  const skillPresentation = useSkillCopyPresentation({
    allRecords,
    catalogue,
    projectionGroups: navigation.projection.groups,
    skillCopiesStatus: skillCopies.status,
    initialSkillCopy: props.initialSkillCopy,
    reveal: navigation.reveal,
    setInfoRef,
    onNavigate: props.onNavigate,
    trigger,
    searchButton,
  });
  const {
    selection: skillSheetSelection,
    clear: clearSkillSheet,
    open: openSkillSheet,
    searchRecords,
    selectSearchResult: navigateSearchResult,
  } = skillPresentation;
  const groupInfoId = groupInfoSelection?.id ?? null;
  const groupInfo =
    groupInfoSelection?.viewKey === navigation.viewKey
      ? navigation.projection.groups.find((group) => group.id === groupInfoSelection.id)?.projectSkillGroup
      : undefined;
  const sheetPath =
    details && navigation.selection && JSON.stringify(navigation.selection.ref) === JSON.stringify(details.resource.ref)
      ? navigation.selection.relativePath
      : undefined;
  const artifactRefKey = artifactRoute && details ? JSON.stringify(details.resource.ref) : "";
  const artifactSelectedPath =
    artifactRoute && details && navigation.selection && JSON.stringify(navigation.selection.ref) === artifactRefKey
      ? navigation.selection.relativePath
      : details?.resource.relativePath;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [workspaceLayout] = useState(createWorkspaceLayoutSession);
  const layoutForSize = (size: Readonly<{ width: number; height: number }>): WorkspaceMapLayout =>
    props.context.kind === "workspace"
      ? workspaceLayout(navigation.projection, size, workspaceMap.progress, mapVisible)
      : layoutCanvas(navigation.projection, size);
  const emptyLayout = layoutForSize({ width: 0, height: 0 });
  const camera = useCanvasCamera({
    viewportRef,
    minimumFitScale: props.context.kind === "workspace" ? 0.5 : undefined,
    pending: props.context.kind === "workspace" && (props.registryLoading || workspaceMap.loading),
    viewKey: navigation.viewKey,
    layout: emptyLayout,
    layoutForSize,
    initialCamera: navigation.initialCamera,
    disabled: setupApplying || copyManagementOpen,
    onCameraChange: navigation.storeCamera,
  });
  const spatialLayout = layoutForSize(camera.size);
  const closeSheet = useCallback((): void => {
    if (setupApplyingRef.current) return;
    if (skillSheetSelection) {
      clearSkillSheet();
      requestAnimationFrame(() => trigger.current?.focus());
      return;
    }
    if (artifactRoute && infoRef === null) {
      const parent = details?.parent;
      if (props.onBack) {
        props.onBack();
        requestAnimationFrame(() => {
          focusResourceNode(details?.resource.ref, navigation.selectedPath);
          if (!document.activeElement || document.activeElement === document.body) trigger.current?.focus();
        });
      } else if (parent) {
        props.onNavigate(routeForResource(parent));
        requestAnimationFrame(() => focusResourceNode(details?.resource.ref, navigation.selectedPath));
      }
      return;
    }
    setInfoRef(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }, [artifactRoute, clearSkillSheet, details?.parent, infoRef, navigation.selectedPath, props, skillSheetSelection]);
  const closeGroupInfo = useCallback((): void => {
    if (setupApplyingRef.current) return;
    setGroupInfoSelection(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }, []);
  const openInfo = useCallback(
    (ref: ResourceRef): void => {
      if (setupApplying) return;
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setup.actions.close();
      setGroupInfoSelection(null);
      clearSkillSheet();
      setInfoRef(ref);
      setSearchOpen(false);
    },
    [clearSkillSheet, setup.actions, setupApplying],
  );
  const openGroupInfo = useCallback(
    (group: ProjectSkillGroup, opener: HTMLButtonElement): void => {
      if (setupApplyingRef.current) return;
      trigger.current = opener;
      setup.actions.close();
      setInfoRef(null);
      clearSkillSheet();
      setSearchOpen(false);
      setGroupInfoSelection({ id: group.id, viewKey: navigation.viewKey });
    },
    [clearSkillSheet, navigation.viewKey, setup.actions],
  );
  const openSearch = useCallback((): void => {
    if (setupApplying) return;
    trigger.current = searchButton.current;
    setup.actions.close();
    setSearchOpen(true);
    setInfoRef(null);
    setGroupInfoSelection(null);
    clearSkillSheet();
  }, [clearSkillSheet, setup.actions, setupApplying]);
  const closeSearch = useCallback((): void => {
    if (setupApplyingRef.current) return;
    setSearchOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }, []);
  const dismissOtherSheets = useCallback(
    (preserveSkillSheet = false): void => {
      setup.actions.close();
      setSearchOpen(false);
      setGroupInfoSelection(null);
      setInfoRef(null);
      if (!preserveSkillSheet) clearSkillSheet();
    },
    [clearSkillSheet, setup.actions.close],
  );
  const isChangesBlocked = useCallback((): boolean => setupApplyingRef.current, []);
  const changes = useCanvasChanges({
    context: props.context,
    centerRef: listing.center?.ref,
    detailsRef: details?.resource.ref,
    initialRequest: props.initialSkillRequest,
    initialSkillIntent: props.initialSkillIntent,
    initialSkillIntentId: props.initialSkillIntentId,
    requestId: props.requestId,
    initialRestoreOperationId: props.initialSkillRestoreOperationId,
    initialResultId: props.initialSkillResultId,
    isBlocked: isChangesBlocked,
    dismissOtherSheets,
    rememberOpener: () => {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    focusOpener: () => trigger.current?.focus(),
    focusResourceNode,
  });
  const resolveSavedRoute = useCallback((id: string, handled: boolean): void => {
    setSavedRouteResolution({ id, handled });
  }, []);
  const closeCopyManagement = useCallback((): void => {
    if (savedRouteId && savedRouteResolution?.id === savedRouteId && savedRouteResolution.handled) {
      changes.close();
      return;
    }
    closeSheet();
  }, [changes.close, closeSheet, savedRouteId, savedRouteResolution]);
  useEffect(() => {
    if (!savedRouteId) setSavedRouteResolution(null);
  }, [savedRouteId]);
  const openSkillVariant = useSkillVariantNavigation({
    catalogue,
    records: allRecords,
    onRefresh: props.onRefresh,
    onObserveSource: props.onObserveAdoptionSource,
    onCloseChanges: changes.close,
    onNavigate: props.onNavigate,
  });

  const canvasOverlayOpen = changes.open || copyManagementOpen || Boolean(props.routeSheet);

  useEffect(() => {
    if (!artifactRoute) {
      setInfoRef(null);
      setGroupInfoSelection(null);
      clearSkillSheet();
      return;
    }
    setInfoRef(null);
    setGroupInfoSelection(null);
    clearSkillSheet();
  }, [artifactRoute, clearSkillSheet, props.context]);

  useEffect(() => {
    if (!groupInfoSelection || groupInfo) return;
    setGroupInfoSelection(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }, [groupInfo, groupInfoSelection]);

  useEffect(() => {
    if (!artifactRoute || !details) return;
    navigation.reveal(details.resource, artifactSelectedPath);
  }, [artifactRoute, artifactRefKey, artifactSelectedPath, navigation.reveal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (props.routeSheet) return;
      const back = (event.metaKey && event.key === "[") || (event.altKey && event.key === "ArrowLeft");
      if (setupApplyingRef.current) {
        if (event.key === "Escape" || back) event.preventDefault();
        return;
      }
      const forward = (event.metaKey && event.key === "]") || (event.altKey && event.key === "ArrowRight");
      if (
        forward &&
        !rail?.overlayOpen &&
        !canvasOverlayOpen &&
        !skillSheetSelection &&
        !infoRef &&
        !setup.state.intent
      ) {
        event.preventDefault();
        props.onForward?.();
      } else if (back && copyManagementOpen) {
        event.preventDefault();
        copyManagementBack.current();
      } else if (back && skillSheetSelection) {
        event.preventDefault();
        closeSheet();
      } else if (back && groupInfoSelection) {
        event.preventDefault();
        closeGroupInfo();
      } else if (back && !artifactRoute && navigation.leaveGroup()) {
        event.preventDefault();
      } else if (back && props.onBack) {
        event.preventDefault();
        props.onBack();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!searchOpen) openSearch();
      } else if (event.key === "Escape") {
        if (setup.state.intent && !setupApplying) setup.actions.close();
        else if (setup.state.intent) return;
        else if (copyManagementOpen) copyManagementClose.current();
        else if (changes.open) changes.close();
        else if (searchOpen) closeSearch();
        else if (groupInfoId) closeGroupInfo();
        else if (skillSheetSelection) closeSheet();
        else if (infoRef) closeSheet();
        else if (artifactRoute) closeSheet();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    artifactRoute,
    closeGroupInfo,
    changes.close,
    closeSearch,
    closeSheet,
    closeCopyManagement,
    copyManagementOpen,
    groupInfoId,
    skillSheetSelection,
    infoRef,
    changes.open,
    navigation.leaveGroup,
    openSearch,
    props.onBack,
    props.onForward,
    rail?.overlayOpen,
    canvasOverlayOpen,
    searchOpen,
    setup.actions,
    setup.state.intent,
    setupApplying,
  ]);

  const selectSearchResult = (resource: ResourceRecord): void => {
    if (setupApplyingRef.current) return;
    setSearchOpen(false);
    if (resource.kind === "external-source" && rail?.externalLibrary.list) {
      rail.openExternalDestination();
      return;
    }
    if (resource.kind === "storefront" && resource.ref.kind === "entry") {
      rail?.openStorefront(resource.ref.entry.id);
      return;
    }
    navigateSearchResult(resource);
  };
  const openSetup = (intent: WorkspaceMapIntent, opener: HTMLElement): void => {
    if (setupApplyingRef.current) return;
    trigger.current = setupMenuButton.current ?? opener;
    setSearchOpen(false);
    setInfoRef(null);
    setGroupInfoSelection(null);
    clearSkillSheet();
    setSetupWriteActive(false);
    if (intent === "agents") {
      rail?.open(rail.delivery.status?.plugins.behind ? "delivery" : "settings");
    } else if (intent === "create-marketplace" || intent === "connect-marketplace") {
      setup.actions.openPersonalMarketplace(intent === "create-marketplace" ? "create" : "connect");
    } else setup.actions.open(intent);
  };
  const closeSetup = (): void => {
    if (setupApplyingRef.current) return;
    setup.actions.close();
    setSetupWriteActive(false);
    requestAnimationFrame(() => {
      const liveMenuTrigger = document.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-menu-trigger']");
      (liveMenuTrigger ?? trigger.current)?.focus();
    });
  };
  const entryView =
    contextEntry?.kind === "source"
      ? props.snapshot.registry.sources.find((entry) => entry.ref.id === contextEntry.id)
      : contextEntry
        ? props.snapshot.registry.projects.find((entry) => entry.ref.id === contextEntry.id)
        : undefined;
  const packageRef =
    props.context.kind === "package"
      ? props.context
      : props.context.kind === "artifact" && details?.parent?.kind === "package"
        ? details.parent
        : null;
  const packageDetails = packageRef ? catalogue.inspect(packageRef) : null;
  const currentLabel = details?.resource.label ?? listing.center?.label ?? entryView?.displayName ?? "";
  const groupLabel =
    navigation.projection.center?.kind === "group"
      ? displayGroupLabel(navigation.projection.center, (key) => t(key as TranslationKey))
      : t("canvas.registeredResources");
  const crumbRoute = (ref: ResourceRef): Route => routeForResource(ref);
  const setSetupWriteActive = useCallback((active: boolean): void => {
    setupApplyingRef.current = active;
    setSetupApplying(active);
  }, []);

  return (
    <div
      aria-busy={setupApplying || props.registryMutationBusy}
      className={`resource-canvas${help ? " is-help-mode" : ""}`}
      data-theme="light"
      data-testid="resource-canvas"
    >
      <CanvasRail busy={setupApplying || canvasOverlayOpen} />
      <header className="canvas-header" inert={setupApplying || canvasOverlayOpen}>
        <nav aria-label={t("canvas.breadcrumbs")} className="canvas-breadcrumbs">
          <button
            onClick={() => {
              if (!setupApplyingRef.current)
                props.onNavigate({ screen: "resource-canvas", context: { kind: "workspace" } });
            }}
            type="button"
          >
            {t("canvas.workspace")}
          </button>
          {entryView && contextEntry ? (
            <>
              <span aria-hidden="true">/</span>
              <button
                onClick={() => {
                  if (!setupApplyingRef.current) props.onNavigate(crumbRoute({ kind: "entry", entry: contextEntry }));
                }}
                type="button"
              >
                {entryView.displayName}
              </button>
            </>
          ) : null}
          {packageRef && packageDetails ? (
            <>
              <span aria-hidden="true">/</span>
              <button
                onClick={() => {
                  if (!setupApplyingRef.current) props.onNavigate(crumbRoute(packageRef));
                }}
                type="button"
              >
                {packageDetails.resource.label}
              </button>
            </>
          ) : null}
          {navigation.groupId ? (
            <>
              <span aria-hidden="true">/</span>
              <button onClick={() => navigation.leaveGroup()} type="button">
                {groupLabel}
              </button>
            </>
          ) : null}
          {artifactRoute && details ? (
            <>
              <span aria-hidden="true">/</span>
              <span>{details.resource.label}</span>
            </>
          ) : null}
        </nav>
        <div className="canvas-header-actions">
          <button
            className="canvas-search-trigger"
            disabled={setupApplying}
            onClick={openSearch}
            ref={searchButton}
            type="button"
          >
            <Icon name="search" size={16} />
            <span>{t("canvas.search")}</span>
            <kbd>⌘K</kbd>
          </button>
          <CanvasAddButton />
          <button
            data-setup-help
            type="button"
            className="canvas-secondary-button"
            aria-pressed={help}
            onClick={() => setHelp(!help)}
          >
            {t("projectView.help")}
          </button>
          <AppUpdateRestartControl api={props.railServices?.api ?? props.api} />
          <button
            aria-label={t("canvas.refresh")}
            className="canvas-icon-button"
            disabled={setupApplying || props.registryMutationBusy || props.registryLoading}
            onClick={() => {
              if (!setupApplyingRef.current && !props.registryMutationBusy && !props.registryLoading) props.onRefresh();
            }}
            type="button"
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </header>
      {help && props.context.kind === "workspace" && workspaceMap.hidden && workspaceMap.progress.count < 3 ? (
        <div className="workspace-setup-help">
          <button
            className="canvas-secondary-button"
            data-testid="workspace-setup-show"
            type="button"
            disabled={!workspaceMap.canSave || workspaceMap.saving}
            onClick={() => {
              void workspaceMap.setHidden(false);
              setHelp(false);
            }}
          >
            {t("canvasSetup.showSetup")}
          </button>
        </div>
      ) : null}
      {props.diagnostic ? (
        <p className="project-error" role="alert">
          {props.diagnostic}
        </p>
      ) : null}
      <CanvasStage
        onEmptyPress={() => {
          if (rail?.surface || rail?.menuOpen) rail.close();
          else if (setup.state.intent) closeSetup();
          else if (searchOpen) closeSearch();
          else if (groupInfo) closeGroupInfo();
          else if (skillSheetSelection || sheetRef) closeSheet();
        }}
        camera={camera}
        canvasOverlayOpen={canvasOverlayOpen}
        comparisonOpen={copyManagementOpen}
        contextIsWorkspace={props.context.kind === "workspace"}
        currentLabel={currentLabel}
        layout={spatialLayout}
        mapGeometry={spatialLayout.map}
        workspaceMap={workspaceMap}
        canvas={props}
        listing={listing}
        onDetails={() => {
          if (listing.center?.kind === "storefront" && listing.center.ref.kind === "entry")
            rail?.openStorefront(listing.center.ref.entry.id);
          else if (listing.center) openInfo(listing.center.ref);
        }}
        onGroupDetails={openGroupInfo}
        onInspect={(node) => {
          if (node.resource.kind === "external-source" && rail?.externalLibrary.list) {
            rail.openExternalDestination();
            return;
          }
          if (node.resource.kind === "storefront" && node.resource.ref.kind === "entry") {
            rail?.openStorefront(node.resource.ref.entry.id);
            return;
          }
          navigation.reveal(node.resource, node.relativePath);
          openInfo(node.resource.ref);
        }}
        onNavigate={(node) => {
          if (setupApplyingRef.current) return;
          if (node.resource.kind === "external-source" && rail?.externalLibrary.list) {
            rail.openExternalDestination();
            return;
          }
          if (node.resource.kind === "storefront" && node.resource.ref.kind === "entry") {
            rail?.openStorefront(node.resource.ref.entry.id);
            return;
          }
          if (
            props.context.kind === "workspace" &&
            node.resource.ref.kind === "entry" &&
            node.resource.ref.entry.kind === "source" &&
            activeWorkshop(props.snapshot.registry)?.ref.id === node.resource.ref.entry.id
          ) {
            rail?.open("owned-marketplace");
            return;
          }
          trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          navigation.reveal(node.resource, node.relativePath);
          const ref = node.resource.ref;
          const drift =
            ref.kind === "entry" && ref.entry.kind === "project"
              ? rail?.delivery.status?.projects.find((project) => project.projectId === ref.entry.id)
              : undefined;
          const route = routeForResource(ref);
          props.onNavigate(
            drift && (drift.conflicts || drift.updates || drift.unavailable) && route.screen === "resource-canvas"
              ? { ...route, initialProjectSheet: "project" }
              : route,
          );
        }}
        onOpenSkillCopies={(node, tab) => {
          if (setupApplyingRef.current) return;
          setup.actions.close();
          setInfoRef(null);
          setGroupInfoSelection(null);
          setSearchOpen(false);
          openSkillSheet(node, tab);
        }}
        onSelectGroup={navigation.selectGroup}
        onSetup={(intent, opener) => openSetup(intent, opener)}
        projection={navigation.projection}
        selection={navigation.selection ?? null}
        setupApplying={setupApplying}
        setupAvailable={Boolean(props.setup?.api)}
        viewportRef={viewportRef}
      />
      {searchOpen ? <CanvasSearch onClose={closeSearch} onSelect={selectSearchResult} records={searchRecords} /> : null}
      {setup.state.intent ? (
        <WorkspaceSetupSheet
          actions={setup.actions}
          activePersonalSource={Boolean(activeWorkshop(props.snapshot.registry))}
          activeProject={props.snapshot.registry.projects.some((entry) => entry.archivedAt === undefined)}
          applying={setupApplying}
          onApplyingChange={setSetupWriteActive}
          onClose={closeSetup}
          onOpenAgents={() => {
            closeSetup();
            rail?.open("settings");
          }}
          setup={props.setup ?? fallbackSetup}
          state={setup.state}
        />
      ) : null}
      {!setup.state.intent && details && !skillSheetSelection ? (
        <ResourceSheet
          api={props.api}
          details={details}
          initialDocument={(artifactRoute && infoRef === null) || Boolean(props.initialSkillCopy && infoRef)}
          initialPath={sheetPath}
          key={JSON.stringify([details.resource.ref, sheetPath ?? null])}
          onClose={closeSheet}
          onEnsureGrant={props.onEnsureGrant}
          onOpenChanges={(sourceId, packageId, projectId, journey) =>
            changes.show({ sourceId, packageId, projectId, journey })
          }
          onOpenMaintenance={(skillIntent) => changes.show({ skillIntent })}
          onOpenRemoval={(bindingId) => changes.show({ removalBindingIds: [bindingId] })}
          snapshot={props.snapshot}
        />
      ) : null}
      <CanvasSkillCopiesLayer
        api={props.api}
        operationOpen={changes.open}
        onClose={closeCopyManagement}
        onApplyingChange={setSetupWriteActive}
        onOpenChange={setCopyManagementOpen}
        onEnsureGrant={props.onEnsureGrant}
        onObserveAdoptionSource={props.onObserveAdoptionSource}
        onRefresh={props.onRefresh}
        reader={skillSheetSelection}
        snapshot={props.snapshot}
        managedUses={skillCopies.status === "ready" ? skillCopies.managedUses : []}
        managedUsesStatus={
          skillCopies.status === "ready" ? "ready" : skillCopies.status === "unavailable" ? "unavailable" : "loading"
        }
        rootKey={rootKey}
        backRef={copyManagementBack}
        closeRef={copyManagementClose}
        visible={!setup.state.intent}
        copyNodes={copyNodes}
        projectId={projectId}
        projectStatus={skillCopies.status}
        savedRouteId={savedRouteId}
        initialRestoreReview={!props.initialSkillResultId && Boolean(props.initialSkillRestoreOperationId)}
        onSavedRouteResolved={resolveSavedRoute}
      />
      {!setup.state.intent && groupInfo ? (
        <CanvasGroupSheet
          group={groupInfo}
          snapshot={props.snapshot}
          onClose={closeGroupInfo}
          onInspectSource={(ref) => {
            if (setupApplyingRef.current) return;
            setGroupInfoSelection(null);
            props.onNavigate(routeForResource(ref));
          }}
        />
      ) : null}
      <CanvasOperationWorkbench
        assignmentChoices={assignmentChoices}
        canvas={props}
        changes={changes}
        onApplyingChange={setSetupWriteActive}
        onOpenVariant={openSkillVariant}
        packageId={packageRef?.packageId}
        suppress={copyManagementOpen || savedRoutePending}
        onConnectAgent={
          props.setup?.api
            ? (opener) => {
                changes.close();
                openSetup("agents", opener);
              }
            : undefined
        }
      />
      <CanvasRailLayer busy={setupApplying || canvasOverlayOpen} onApplyingChange={setSetupWriteActive} />
    </div>
  );
}
