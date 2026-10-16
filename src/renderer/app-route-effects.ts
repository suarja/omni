import { activeWorkshop } from "../domain/source-roles";
import type { Dispatch, SetStateAction } from "react";
import type { EntryRef } from "../domain/project-source-registry";
import type { AuditObservation } from "./audit/audit-report";
import type { ObservationResponse, RegistryViewResponse } from "../shared/registry-ipc";
import type { Route } from "./navigation";
import type { RegistryError } from "./registry/registry-error";
import { resolveCanvasRoute } from "./canvas-route";

type State<T> = Dispatch<SetStateAction<T>>;

export function routeForEntry(ref: EntryRef): Route {
  return { screen: "resource-canvas", context: { kind: "entry", entry: ref } };
}

export function navigateToRouteEffect(
  requestedRoute: Route,
  deps: Readonly<{
    selectRegistryEntry: (ref: EntryRef, route: Route) => Promise<void>;
    setRoute: State<Route | null>;
    setRegistryError: State<RegistryError | null>;
  }>,
): void {
  const nextRoute = resolveCanvasRoute(requestedRoute) ?? requestedRoute;
  if (nextRoute.screen === "resource-canvas") {
    if (nextRoute.context.kind !== "workspace") {
      void deps.selectRegistryEntry(nextRoute.context.entry, nextRoute);
      return;
    }
    deps.setRoute(nextRoute);
    deps.setRegistryError(null);
    return;
  }
  deps.setRoute(nextRoute);
  deps.setRegistryError(null);
}

export function clearMarketplaceObservation(
  deps: Readonly<{
    registry: RegistryViewResponse | null;
    setObservations: State<Readonly<Record<string, ObservationResponse>>>;
    setEntryIdentities: State<Readonly<Record<string, AuditObservation>>>;
    observationKey: (ref: EntryRef) => string;
    loadRegistry: (options?: { preserveSelection?: boolean }) => Promise<RegistryViewResponse | null>;
    route: Route | null;
  }>,
): void {
  const personal = deps.registry?.status === "ready" ? activeWorkshop(deps.registry.registry) : undefined;
  if (personal) {
    const key = deps.observationKey(personal.ref);
    deps.setObservations((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    deps.setEntryIdentities((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
  void deps.loadRegistry({
    preserveSelection:
      deps.route?.screen === "operation-import" ||
      (deps.route?.screen === "resource-canvas" && Boolean(deps.route.initialOperation)),
  });
}

export function clearProjectObservation(
  projectId: string,
  deps: Readonly<{
    setObservations: State<Readonly<Record<string, ObservationResponse>>>;
    setEntryIdentities: State<Readonly<Record<string, AuditObservation>>>;
    observationKey: (ref: EntryRef) => string;
    refreshBindings: () => void;
    loadRegistry: (options?: { preserveSelection?: boolean }) => Promise<RegistryViewResponse | null>;
  }>,
): void {
  const key = deps.observationKey({ kind: "project", id: projectId });
  deps.setObservations((current) => {
    const next = { ...current };
    delete next[key];
    return next;
  });
  deps.setEntryIdentities((current) => {
    const next = { ...current };
    delete next[key];
    return next;
  });
  deps.refreshBindings();
  void deps.loadRegistry({ preserveSelection: true });
}
