import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { AppShell } from "./shell/AppShell";
import { useI18n } from "./i18n";
import {
  resolveLaunchDestination,
  routeForDestination,
  entryForRoute,
  type Destination,
  type Route,
} from "./navigation";
import { type RegistryError } from "./registry/registry-error";
import { useTheme } from "./theme/theme-provider";
import { useAuditSession } from "./audit/use-audit-session";
import {
  readCurrentAuditReport,
  registryObservationFingerprint,
  selectedRefsKey,
  type AuditSnapshot,
} from "./audit/audit-snapshot";
import type { AuditObservation } from "./audit/audit-report";
import {
  createRegistryOperationCoordinator,
  type RegistryMutationToken,
} from "./registry/registry-operation-coordinator";
import { useRegistryRegistration } from "./registry/use-registry-registration";
import { useMarketplaceObservation } from "./operations/use-marketplace-observation";
import { useGrantManager } from "./grant-manager";
import type { EntryRef } from "../domain/project-source-registry";
import type { DesktopApi } from "../shared/ipc";
import type { ObservationResponse, OpenEntryResponse, RegistryViewResponse } from "../shared/registry-ipc";
import { getDesktopApi, observationKey, readError } from "./app-helpers";
import { useSelectRegistryEntry } from "./app-select-entry";
import { useClearRegistrySelection, useDestinationNavigation } from "./app-navigation";
import {
  clearMarketplaceObservation,
  clearProjectObservation,
  navigateToRouteEffect,
  routeForEntry,
} from "./app-route-effects";
import { getDestinationObservation, getMarketplaceObservation } from "./app-destination-state";
import { useRouteHistory } from "./use-route-history";
import { FeaturesProvider, useBootFeatures } from "./features";
import { useAppCatalogue } from "./app-catalogue";
import { createResourceSnapshot } from "./canvas/resource-snapshot";
import type { WorkspaceSetupInputs } from "./canvas/setup/workspace-setup-types";
import { observeAdoptionSource } from "./app-observe-adoption-source";

export { getDesktopApi } from "./app-helpers";
type RegistryLoadOptions = Readonly<{ mutationToken?: RegistryMutationToken; preserveSelection?: boolean }>;

export function App(): ReactElement {
  const { t } = useI18n();
  const { mode, setMode } = useTheme();
  const [api] = useState<DesktopApi | null>(() => {
    try {
      return getDesktopApi();
    } catch {
      return null;
    }
  });
  const [route, setRoute] = useState<Route | null>(null);
  const featuresState = useBootFeatures(api);
  const [registry, setRegistry] = useState<RegistryViewResponse | null>(null);
  const registryRef = useRef<RegistryViewResponse | null>(registry);
  registryRef.current = registry;
  const [registryError, setRegistryError] = useState<RegistryError | null>(null);
  const [openedEntry, setOpenedEntry] = useState<OpenEntryResponse | null>(null);
  const { bindings, bindingsSnapshot, ensureGrant, grantCache, grantIssuedAt, refreshBindings, removeBinding } =
    useGrantManager(api, setOpenedEntry);
  const [pendingObservations, setPendingObservations] = useState<Readonly<Record<string, number>>>({});
  const [observations, setObservations] = useState<Readonly<Record<string, ObservationResponse>>>({});
  const [entryIdentities, setEntryIdentities] = useState<Readonly<Record<string, AuditObservation>>>({});
  const [auditSnapshot, setAuditSnapshot] = useState<AuditSnapshot | null>(null);
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryLoading, setRegistryLoading] = useState(false);
  const registryLoadsInFlight = useRef(0);
  const [registryMutationBusy, setRegistryMutationBusy] = useState(false);
  const registrySelection = useRef(0);
  const registryGeneration = useRef(0);
  const registryOperationGeneration = useRef(0);
  const registryLoad = useRef(0);
  const registryOperationCount = useRef(0);
  const registryOperationCoordinator = useRef(createRegistryOperationCoordinator());
  const bootstrapped = useRef(false);
  const auditSelectedRefs = useMemo(
    () =>
      registry?.status === "ready"
        ? [...registry.registry.projects, ...registry.registry.sources]
            .filter((entry) => !entry.archivedAt && entry.availability === "available")
            .map((entry) => entry.ref)
        : undefined,
    [registry],
  );
  const audit = useAuditSession({ api, registry, selectedRefs: auditSelectedRefs });
  const currentRegistryFingerprint =
    registry?.status === "ready" ? registryObservationFingerprint(registry.registry) : null;
  useEffect(() => {
    if (audit.status === "running" && audit.report === null) {
      setAuditSnapshot(null);
    } else if (
      audit.report &&
      currentRegistryFingerprint !== null &&
      audit.reportRegistryFingerprint === currentRegistryFingerprint &&
      audit.reportSelectedRefsKey === selectedRefsKey(auditSelectedRefs)
    ) {
      setAuditSnapshot({
        report: audit.report,
        registryFingerprint: currentRegistryFingerprint,
        selectedRefsKey: selectedRefsKey(auditSelectedRefs),
      });
    }
  }, [
    audit.report,
    audit.reportRegistryFingerprint,
    audit.reportSelectedRefsKey,
    audit.status,
    auditSelectedRefs,
    currentRegistryFingerprint,
  ]);
  const currentAuditReport = readCurrentAuditReport(
    auditSnapshot,
    registry?.status === "ready" ? registry.registry : null,
    auditSelectedRefs,
  );
  const destinationAudit = {
    ...audit,
    status:
      (audit.status === "completed" || audit.status === "error") && currentAuditReport === null
        ? ("idle" as const)
        : audit.status,
    report: currentAuditReport,
  };
  const catalogue = useAppCatalogue(currentAuditReport, entryIdentities, registry);
  const beginRegistryOperation = useCallback((): void => {
    registryOperationCount.current += 1;
    setRegistryBusy(true);
  }, []);

  const endRegistryOperation = useCallback((): void => {
    registryOperationCount.current = Math.max(0, registryOperationCount.current - 1);
    setRegistryBusy(registryOperationCount.current > 0);
  }, []);

  const beginRegistryMutation = useCallback((): RegistryMutationToken | null => {
    const token = registryOperationCoordinator.current.beginMutation();
    if (token === null) return null;
    setRegistryMutationBusy(true);
    beginRegistryOperation();
    return token;
  }, [beginRegistryOperation]);

  const endRegistryMutation = useCallback(
    (token: RegistryMutationToken): void => {
      if (!registryOperationCoordinator.current.endMutation(token)) return;
      setRegistryMutationBusy(false);
      endRegistryOperation();
    },
    [endRegistryOperation],
  );

  const clearRegistrySelection = useClearRegistrySelection({
    registryGeneration,
    registrySelection,
    setOpenedEntry,
    setObservations,
    setEntryIdentities,
  });

  const loadRegistry = useCallback(
    async (options: RegistryLoadOptions = {}): Promise<RegistryViewResponse | null> => {
      const mutationToken = options.mutationToken;
      const loadToken = registryOperationCoordinator.current.beginLoad(mutationToken);
      if (loadToken === null) return null;
      const loadId = registryLoad.current + 1;
      registryLoad.current = loadId;
      if (!options.preserveSelection) clearRegistrySelection();
      else {
        registryGeneration.current += 1;
        registrySelection.current += 1;
      }
      const operationGeneration = registryOperationGeneration.current;
      if (!api) {
        setRegistryError({ message: t("errors.preloadUnavailable") });
        return null;
      }
      registryLoadsInFlight.current += 1;
      setRegistryLoading(true);
      beginRegistryOperation();
      setRegistryError(null);
      try {
        const response = await api.listRegistry();
        if (
          registryLoad.current !== loadId ||
          registryOperationGeneration.current !== operationGeneration ||
          !registryOperationCoordinator.current.isLoadAuthorized(loadToken)
        )
          return null;
        setRegistry(response);
        if (response.status === "ready") {
          setRoute((current) => current ?? routeForDestination(resolveLaunchDestination(response.registry)));
        } else {
          setRoute(null);
        }
        return response;
      } catch (loadError: unknown) {
        if (
          registryLoad.current === loadId &&
          registryOperationGeneration.current === operationGeneration &&
          registryOperationCoordinator.current.isLoadAuthorized(loadToken)
        )
          setRegistryError(readError(loadError, t("registry.loadFailed")));
        return null;
      } finally {
        registryLoadsInFlight.current -= 1;
        setRegistryLoading(registryLoadsInFlight.current > 0);
        endRegistryOperation();
      }
    },
    [api, beginRegistryOperation, clearRegistrySelection, endRegistryOperation, t],
  );

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void loadRegistry();
  }, [loadRegistry]);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void api
        ?.listRegistry()
        .then((current) => {
          const previous = registryRef.current;
          if (
            active &&
            current.status === "ready" &&
            previous?.status === "ready" &&
            current.registry.revision !== previous.registry.revision
          )
            void loadRegistry({ preserveSelection: true });
        })
        .catch(() => undefined);
    };
    const unsubscribe = api?.onReviewChanged?.(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      unsubscribe?.();
      window.removeEventListener("focus", refresh);
    };
  }, [api, loadRegistry]);

  const setObservationPending = useCallback((ref: EntryRef, requestId: number, pending: boolean): void => {
    const key = observationKey(ref);
    setPendingObservations((current) => {
      if (pending) return { ...current, [key]: requestId };
      if (current[key] !== requestId) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const selectRegistryEntry = useSelectRegistryEntry({
    canSelect: () => registryLoadsInFlight.current === 0 && !registryOperationCoordinator.current.isMutationActive(),
    api,
    currentAuditReport,
    observations,
    openedEntry,
    grantCache,
    grantIssuedAt,
    registryGeneration,
    registrySelection,
    setOpenedEntry,
    setObservations,
    setEntryIdentities,
    setRegistry,
    setRegistryError,
    setObservationPending,
    setRoute,
    beginRegistryOperation,
    endRegistryOperation,
    clearRegistrySelection,
    t,
  });
  const observeWorkspaceEntry = useCallback(
    (entry: EntryRef): Promise<void> =>
      selectRegistryEntry(entry, { screen: "resource-canvas", context: { kind: "workspace" } }, true),
    [selectRegistryEntry],
  );
  const observeSourceForAdoption = useCallback(
    (sourceId: string, isCurrent: () => boolean) => {
      if (!api) return Promise.resolve(null);
      return observeAdoptionSource(sourceId, {
        api,
        registry: () => registryRef.current,
        registryGeneration,
        isCurrent,
        setObservations,
        setEntryIdentities,
        grantCache,
        grantIssuedAt,
        identityMismatchDiagnostic: t("registry.responseIdentityMismatch"),
        onIdentityMismatch: () => {
          clearRegistrySelection();
          setRegistryError({ message: t("registry.responseIdentityMismatch") });
        },
        onCorrupt: (result) => {
          clearRegistrySelection();
          setRegistry(result);
          setRegistryError(null);
        },
      });
    },
    [api, clearRegistrySelection, t],
  );

  const { registerProject, registerSource } = useRegistryRegistration({
    api,
    sourceOwnership: "personal",
    beginRegistryMutation,
    endRegistryMutation,
    clearRegistrySelection,
    loadRegistry,
    setRegistry,
    setRegistryError,
  });

  useMarketplaceObservation({
    api,
    currentAuditReport,
    observations,
    registry,
    route,
    setEntryIdentities,
    setObservations,
  });

  const navigate = useDestinationNavigation({ setOpenedEntry, setRoute, setRegistryError });

  const navigateToRoute = useCallback(
    (nextRoute: Route): void =>
      navigateToRouteEffect(nextRoute, {
        selectRegistryEntry,
        setRoute,
        setRegistryError,
      }),
    [selectRegistryEntry],
  );
  const refreshSkillAdoption = useCallback(async (): Promise<void> => {
    await refreshBindings();
    const currentRoute = route;
    if (
      currentRoute?.screen === "resource-canvas" &&
      currentRoute.context.kind === "entry" &&
      currentRoute.context.entry.kind === "project"
    )
      await selectRegistryEntry(currentRoute.context.entry, currentRoute, true);
  }, [refreshBindings, route, selectRegistryEntry]);

  const onMarketplaceChanged = useCallback(
    (): void =>
      clearMarketplaceObservation({
        registry,
        setObservations,
        setEntryIdentities,
        observationKey,
        loadRegistry,
        route,
      }),
    [loadRegistry, registry, route],
  );

  const onProjectChanged = useCallback(
    (projectId: string): void =>
      clearProjectObservation(projectId, {
        setObservations,
        setEntryIdentities,
        observationKey,
        refreshBindings,
        loadRegistry,
      }),
    [loadRegistry, refreshBindings],
  );
  const destinationObservation = getDestinationObservation(route, openedEntry, observations);
  const marketplaceObservation = getMarketplaceObservation(registry, observations, currentAuditReport);
  const routeHistory = useRouteHistory(route, setRoute);
  const resourceSnapshot =
    registry?.status === "ready"
      ? createResourceSnapshot({
          registry: registry.registry,
          observations,
          auditObservations: currentAuditReport?.observations ?? [],
          pendingObservations: Object.fromEntries(Object.keys(pendingObservations).map((key) => [key, true])),
          uses: bindingsSnapshot,
        })
      : null;
  const workspaceSetup = useMemo<WorkspaceSetupInputs | undefined>(
    () =>
      resourceSnapshot
        ? {
            snapshot: resourceSnapshot,
            api,
            commands: {
              registerProject: (grantHandle) => registerProject({ preserveSelection: true, grantHandle }),
              registerSource: (ownership) => registerSource(ownership, { preserveSelection: true }),
              refreshRegistry: () => loadRegistry({ preserveSelection: true }),
              observeEntry: observeWorkspaceEntry,
            },
            registryBusy: registryBusy || registryMutationBusy,
            diagnostic: registryError?.message ?? null,
          }
        : undefined,
    [
      api,
      loadRegistry,
      observeWorkspaceEntry,
      registerProject,
      registerSource,
      registryBusy,
      registryError?.message,
      registryMutationBusy,
      resourceSnapshot,
    ],
  );

  return (
    <FeaturesProvider value={featuresState}>
      <AppShell
        {...routeHistory}
        catalogue={catalogue}
        api={api}
        destinationObservation={destinationObservation}
        marketplaceObservation={marketplaceObservation}
        route={route}
        resourceSnapshot={resourceSnapshot}
        setup={workspaceSetup}
        mode={mode}
        onModeChange={setMode}
        onNavigate={navigate}
        onNavigateToRoute={navigateToRoute}
        onReaudit={() => {
          if (route?.screen === "resource-canvas" && route.context.kind !== "workspace")
            void selectRegistryEntry(route.context.entry, route, true);
          else if (route?.screen === "project")
            void selectRegistryEntry({ kind: "project", id: route.projectId }, route, true);
          else if (route?.screen === "marketplace" || route?.screen === "package")
            void selectRegistryEntry({ kind: "source", id: route.sourceId }, route, true);
        }}
        onRefreshRegistry={loadRegistry}
        onMarketplaceChanged={onMarketplaceChanged}
        onProjectChanged={onProjectChanged}
        onRetry={() => void loadRegistry()}
        openedEntry={openedEntry}
        registry={registry}
        registryBusy={registryBusy}
        registryLoading={registryLoading}
        registryMutationBusy={registryMutationBusy}
        registryError={registryError}
        destinationAudit={destinationAudit}
        bindings={bindings}
        bindingsSnapshot={bindingsSnapshot}
        observations={observations}
        onEnsureGrant={ensureGrant}
        onObserveAdoptionSource={observeSourceForAdoption}
        onRefreshSkillAdoption={refreshSkillAdoption}
        onBindingsChanged={refreshBindings}
        onRemoveBinding={removeBinding}
      />
    </FeaturesProvider>
  );
}
