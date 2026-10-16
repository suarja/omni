import { activeWorkshop } from "../domain/source-roles";
import type { AuditReport } from "./audit/audit-report";
import type { Observation } from "../domain/project-source-registry";
import type { ObservationResponse, OpenEntryResponse, RegistryViewResponse } from "../shared/registry-ipc";
import { observationKey } from "./app-helpers";
import { entryForRoute, type Route } from "./navigation";

export function getDestinationObservation(
  route: Route | null,
  openedEntry: OpenEntryResponse | null,
  observations: Readonly<Record<string, ObservationResponse>>,
): ObservationResponse | null {
  if (!route) return null;
  if (route.screen === "resource-canvas" && route.context.kind === "workspace") return null;
  const ref = entryForRoute(route) ?? (openedEntry && openedEntry.status !== "corrupt" ? openedEntry.entry.ref : null);
  return ref ? (observations[observationKey(ref)] ?? null) : null;
}

export function getMarketplaceObservation(
  registry: RegistryViewResponse | null,
  observations: Readonly<Record<string, ObservationResponse>>,
  currentAuditReport: AuditReport | null,
): Observation | null {
  if (registry?.status !== "ready") return null;
  const personal = activeWorkshop(registry.registry);
  if (!personal) return null;
  const cached = observations[observationKey(personal.ref)];
  return cached?.status === "observed"
    ? cached.observation
    : (currentAuditReport?.observations.find(
        (observation) => observation.subject.kind === "source" && observation.subject.id === personal.ref.id,
      ) ?? null);
}
