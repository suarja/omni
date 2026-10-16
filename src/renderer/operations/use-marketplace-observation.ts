import { activeWorkshop } from "../../domain/source-roles";
import { useEffect, type Dispatch, type SetStateAction } from "react";

import type { AuditObservation, AuditReport } from "../audit/audit-report";
import { hashObservation } from "../audit/use-audit-session";
import type { EntryRef } from "../../domain/project-source-registry";
import type { DesktopApi } from "../../shared/ipc";
import type { ObservationResponse, RegistryViewResponse } from "../../shared/registry-ipc";
import type { Route } from "../navigation";

function observationKey(ref: EntryRef): string {
  return `${ref.kind}:${ref.id}`;
}

const MARKETPLACE_OBSERVATION_SCREENS = new Set<Route["screen"]>([
  "operation-import",
  "operation-import-catalogue",
  "add-to-project",
]);

export function useMarketplaceObservation({
  api,
  currentAuditReport,
  observations,
  registry,
  route,
  setEntryIdentities,
  setObservations,
}: Readonly<{
  api: DesktopApi | null;
  currentAuditReport: AuditReport | null;
  observations: Readonly<Record<string, ObservationResponse>>;
  registry: RegistryViewResponse | null;
  route: Route | null;
  setObservations: Dispatch<SetStateAction<Readonly<Record<string, ObservationResponse>>>>;
  setEntryIdentities: Dispatch<SetStateAction<Readonly<Record<string, AuditObservation>>>>;
}>): void {
  const operationScreen = route?.screen === "resource-canvas" ? route.initialOperation?.screen : route?.screen;
  useEffect(() => {
    if (
      !operationScreen ||
      !MARKETPLACE_OBSERVATION_SCREENS.has(operationScreen) ||
      registry?.status !== "ready" ||
      !api
    )
      return;
    const personal = activeWorkshop(registry.registry);
    if (!personal) return;
    const key = observationKey(personal.ref);
    const cached =
      observations[key]?.status === "observed" ||
      currentAuditReport?.observations.some(
        (observation) => observation.subject.kind === "source" && observation.subject.id === personal.ref.id,
      );
    if (cached) return;
    let active = true;
    // An observation in the session cache always comes with its identities (the same pair the
    // Library builds when it opens the entry): a picker's observation is then a full one, and the
    // Library tile and "All assets" read it as such (flow audit F12).
    void api
      .openEntry(personal.ref)
      .then(async (opened) => {
        if (!active || opened.status !== "granted") return;
        const observation = await api.observeSource({ sourceId: personal.ref.id, grantHandle: opened.grantHandle });
        if (!active || observation.status !== "observed") return;
        setObservations((current) => ({ ...current, [key]: observation }));
        // Storing the observation re-runs this effect (it depends on `observations`), which
        // cancels this run; the identities of the observation just stored are still wanted.
        const hashed = await hashObservation(api, personal.ref, opened.grantHandle, observation.observation);
        if (hashed.status !== "corrupt") setEntryIdentities((current) => ({ ...current, [key]: hashed.observation }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, currentAuditReport, observations, registry, operationScreen, setEntryIdentities, setObservations]);
}
