import type { ReactElement } from "react";
import { ChangesWorkbench } from "../canvas/changes/ChangesWorkbench";
import { EmptyState } from "../components/ui/EmptyState";
import { useI18n } from "../i18n";
import { entryForRoute, type Destination, type Route } from "../navigation";
import { resolveCanvasRoute } from "../canvas-route";
import { CatalogueTab } from "../library/CatalogueTab";
import { CatalogueEntryPage } from "../library/CatalogueEntryPage";
import { LearnView } from "../learn/LearnView";
import { LessonPage } from "../learn/LessonPage";
import { AgentSessionView } from "../activity/AgentSessionView";
import { AgentsView } from "../activity/AgentsView";
import { WorktreesView } from "../activity/WorktreesView";
import { HarnessSettingPage } from "../operations/HarnessSettingPage";
import type { AuditSession } from "../audit/use-audit-session";
import type { RegistryError } from "../registry/registry-error";
import type { BindingPreviewGroup } from "../review/binding-previews";
import type { EntryRef, Observation, RegistryView as Registry } from "../../domain/project-source-registry";
import type { ObservationResponse, OpenEntryResponse, RegistryViewResponse } from "../../shared/registry-ipc";
import type { DesktopApi } from "../../shared/ipc";
import type { ThemeMode } from "../theme/theme-provider";
import type { CatalogueUnit } from "../catalogue/catalogue";
import type { Binding } from "../../domain/assignment-plan";
import type { BindingSnapshot, ResourceSnapshot } from "../../domain/resource-catalogue";
import { ResourceCanvas } from "../canvas/ResourceCanvas";
import { SheetFrame } from "../canvas/SheetFrame";
import type { CanvasSession } from "../canvas/spatial/spatial-types";
import type { WorkspaceSetupInputs } from "../canvas/setup/workspace-setup-types";
import { createResourceSnapshot } from "../canvas/resource-snapshot";
const NO_RESOURCE_GRANT = async (_entry: EntryRef): Promise<string | null> => null;
export type AppShellProps = Readonly<{
  api: DesktopApi | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onForward?: () => void;
  catalogue?: readonly CatalogueUnit[];
  onBack?: () => void;
  destinationAudit: AuditSession;
  destinationObservation: ObservationResponse | null;
  marketplaceObservation?: Observation | null;
  mode: ThemeMode;
  onModeChange: (mode: ThemeMode) => void;
  onNavigate: (destination: Destination) => void;
  onNavigateToRoute: (route: Route) => void;
  onReaudit: () => void;
  onRefreshRegistry: (options?: Readonly<{ preserveSelection?: boolean }>) => Promise<RegistryViewResponse | null>;
  onMarketplaceChanged?: () => void;
  onProjectChanged?: (projectId: string) => void;
  onRetry: () => void;
  openedEntry: OpenEntryResponse | null;
  registry: RegistryViewResponse | null;
  registryBusy: boolean;
  registryLoading?: boolean;
  registryMutationBusy: boolean;
  registryError: RegistryError | null;
  route: Route | null;
  bindings?: readonly Binding[];
  bindingsSnapshot?: BindingSnapshot;
  resourceSnapshot?: ResourceSnapshot | null;
  setup?: WorkspaceSetupInputs;
  observations?: Readonly<Record<string, ObservationResponse>>;
  onEnsureGrant?: (ref: EntryRef) => Promise<string | null>;
  onObserveAdoptionSource?: (sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>;
  onRefreshSkillAdoption?: () => Promise<void>;
  onBindingsChanged?: () => void;
  onRemoveBinding?: (bindingId: string) => void;
  bindingPreviews?: readonly BindingPreviewGroup[];
}>;

export function renderRoute(
  route: Route,
  registry: Registry,
  props: AppShellProps,
  t: ReturnType<typeof useI18n>["t"],
  canvasSession?: CanvasSession,
): ReactElement {
  const resolved = resolveCanvasRoute(route);
  const entry = entryForRoute(route);
  const canvasRoute = resolved ?? {
    screen: "resource-canvas" as const,
    context: entry ? { kind: "entry" as const, entry } : { kind: "workspace" as const },
  };
  const snapshot =
    props.resourceSnapshot ??
    createResourceSnapshot({
      registry,
      observations: props.observations ?? {},
      auditObservations: props.destinationAudit.report?.observations ?? [],
      pendingObservations: {},
      uses: props.bindingsSnapshot ?? { status: "ready", bindings: props.bindings ?? [] },
    });
  const closeRoute = (): void =>
    props.onNavigateToRoute(
      "returnTo" in route && typeof route.returnTo === "object"
        ? route.returnTo
        : { screen: "resource-canvas", context: { kind: "workspace" } },
    );
  const operationRoute = canvasRoute.initialOperation;
  const auxiliary = resolved ? undefined : renderAuxiliaryRoute(route, registry, props, t);
  const routeSheet = operationRoute ? (
    <ChangesWorkbench
      mode="route"
      key={JSON.stringify(operationRoute)}
      route={operationRoute}
      registry={registry}
      shell={props}
      onClose={() =>
        props.onNavigateToRoute(
          "returnTo" in operationRoute
            ? operationRoute.returnTo
            : { screen: "resource-canvas", context: { kind: "workspace" }, initialRailSurface: "activity" },
        )
      }
    />
  ) : !auxiliary ? undefined : (
    <SheetFrame
      title={t("canvas.details")}
      kicker={t("canvas.workspace")}
      testId="canvas-route-sheet"
      busy={false}
      onClose={closeRoute}
    >
      {auxiliary}
    </SheetFrame>
  );
  return (
    <ResourceCanvas
      railServices={{
        api: props.api,
        audit: props.destinationAudit,
        bindingPreviews: props.bindingPreviews,
        mode: props.mode,
        onModeChange: props.onModeChange,
      }}
      api={props.api}
      context={canvasRoute.context}
      canvasPage={canvasRoute.canvasPage}
      initialExternalSelection={canvasRoute.initialExternalSelection}
      initialMarketplaceSkill={canvasRoute.initialMarketplaceSkill}
      initialRailSurface={canvasRoute.initialRailSurface}
      initialProjectSheet={canvasRoute.initialProjectSheet}
      initialSettingsRoute={canvasRoute.initialSettingsRoute}
      initialSkillIntent={canvasRoute.initialSkillIntent}
      initialSkillIntentId={canvasRoute.initialSkillIntentId}
      initialPublicationRequest={canvasRoute.initialPublicationRequest}
      initialSkillRequest={canvasRoute.initialSkillRequest}
      initialSkillCopy={canvasRoute.initialSkillCopy}
      initialSkillRestoreOperationId={canvasRoute.initialSkillRestoreOperationId}
      initialSkillResultId={canvasRoute.initialSkillResultId}
      requestId={canvasRoute.requestId}
      routeSheet={routeSheet}
      diagnostic={props.registryError?.message}
      registryLoading={props.registryLoading}
      registryMutationBusy={props.registryMutationBusy}
      onBack={props.canGoBack ? props.onBack : undefined}
      onForward={props.canGoForward ? props.onForward : undefined}
      onEnsureGrant={props.onEnsureGrant ?? NO_RESOURCE_GRANT}
      onObserveAdoptionSource={props.onObserveAdoptionSource}
      onRefreshSkillAdoption={props.onRefreshSkillAdoption}
      onNavigate={props.onNavigateToRoute}
      onNavigateDestination={props.onNavigate}
      onRefresh={() =>
        canvasRoute.context.kind === "workspace"
          ? props.onRefreshRegistry({ preserveSelection: true })
          : props.onReaudit()
      }
      snapshot={snapshot}
      setup={props.setup}
      session={canvasSession}
    />
  );
}
function renderAuxiliaryRoute(
  route: Route,
  registry: Registry,
  props: AppShellProps,
  t: ReturnType<typeof useI18n>["t"],
): ReactElement {
  if (route.screen === "library" && route.tab === "catalogue")
    return <CatalogueTab api={props.api} onNavigateToRoute={props.onNavigateToRoute} />;
  if (route.screen === "catalogue-entry")
    return (() => {
      const projectReturnTo =
        entryForRoute(route.returnTo)?.kind === "project" ? entryForRoute(route.returnTo) : undefined;
      const project = projectReturnTo
        ? registry.projects.find((candidate) => candidate.ref.id === projectReturnTo.id)
        : undefined;
      return (
        <CatalogueEntryPage
          api={props.api}
          ownerRepo={route.ownerRepo}
          onNavigateToRoute={props.onNavigateToRoute}
          projectName={project?.displayName || project?.displayRoot}
          returnTo={route.returnTo}
          skill={route.skill}
        />
      );
    })();
  if (route.screen === "learn") {
    return <LearnView api={props.api} onNavigateToRoute={props.onNavigateToRoute} />;
  }
  if (route.screen === "academy-lesson") {
    return (
      <LessonPage
        api={props.api}
        kind={route.kind}
        lang={route.lang}
        onNavigateToRoute={props.onNavigateToRoute}
        slug={route.slug}
      />
    );
  }
  if (route.screen === "activity-agents") {
    return <AgentsView api={props.api} onNavigateToRoute={props.onNavigateToRoute} />;
  }
  if (route.screen === "activity-agent") {
    return <AgentSessionView api={props.api} onNavigateToRoute={props.onNavigateToRoute} sessionId={route.sessionId} />;
  }
  if (route.screen === "activity-worktrees") {
    return <WorktreesView api={props.api} onNavigateToRoute={props.onNavigateToRoute} projectId={route.projectId} />;
  }
  if (route.screen === "worktree-cleanup") {
    return <HarnessSettingPage api={props.api} onNavigateToRoute={props.onNavigateToRoute} returnTo={route.returnTo} />;
  }
  return <EmptyState description={t("bootstrap.loadingDescription")} title={t("bootstrap.loading")} />;
}
