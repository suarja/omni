import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { AuditObservation, AuditReport } from "./audit/audit-report";
import { hashObservation } from "./audit/use-audit-session";
import { GRANT_REUSE_MS } from "./grant-manager";
import type { EntryRef, Observation, RegistryView } from "../domain/project-source-registry";
import type { DesktopApi } from "../shared/ipc";
import type { ObservationResponse, OpenEntryResponse, RegistryViewResponse } from "../shared/registry-ipc";
import { observationKey, observationMatches, openedEntryMatches, readError } from "./app-helpers";
import type { RegistryError } from "./registry/registry-error";
import { useI18n } from "./i18n";
import type { Route } from "./navigation";

type SelectRegistryEntryParams = Readonly<{
  api: DesktopApi | null;
  canSelect?: () => boolean;
  currentAuditReport: AuditReport | null;
  observations: Readonly<Record<string, ObservationResponse>>;
  openedEntry: OpenEntryResponse | null;
  grantCache: { current: Readonly<Record<string, { grantHandle: string; issuedAt: number }>> };
  grantIssuedAt: { current: number };
  registryGeneration: { current: number };
  registrySelection: { current: number };
  setOpenedEntry: Dispatch<SetStateAction<OpenEntryResponse | null>>;
  setObservations: Dispatch<SetStateAction<Readonly<Record<string, ObservationResponse>>>>;
  setEntryIdentities: Dispatch<SetStateAction<Readonly<Record<string, AuditObservation>>>>;
  setRegistry: Dispatch<SetStateAction<RegistryViewResponse | null>>;
  setRegistryError: Dispatch<SetStateAction<RegistryError | null>>;
  setObservationPending: (ref: EntryRef, requestId: number, pending: boolean) => void;
  setRoute: Dispatch<SetStateAction<Route | null>>;
  beginRegistryOperation: () => void;
  endRegistryOperation: () => void;
  clearRegistrySelection: () => void;
  t: ReturnType<typeof useI18n>["t"];
}>;

export function useSelectRegistryEntry({
  api,
  canSelect,
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
}: SelectRegistryEntryParams): (ref: EntryRef, nextRoute: Route, forceObserve?: boolean) => Promise<void> {
  return useCallback(
    async (ref: EntryRef, nextRoute: Route, forceObserve = false): Promise<void> => {
      if (canSelect && !canSelect()) return;
      // Grants expire in the main process (5 min); renew before reuse so reads never come back denied.
      const grantFresh = Date.now() - grantIssuedAt.current < GRANT_REUSE_MS;
      const grantOpen =
        grantFresh &&
        openedEntry?.status === "granted" &&
        openedEntry.entry.ref.kind === ref.kind &&
        openedEntry.entry.ref.id === ref.id;
      const liveObservation = observations[observationKey(ref)];
      const cachedObservation = forceObserve
        ? undefined
        : liveObservation?.status === "observed"
          ? liveObservation.observation
          : currentAuditReport?.observations.find(
              (candidate) => candidate.subject.kind === ref.kind && candidate.subject.id === ref.id,
            );
      if (cachedObservation) {
        setRoute(nextRoute);
        setRegistryError(null);
        setObservations((current) => ({
          ...current,
          [observationKey(ref)]: { status: "observed", observation: cachedObservation },
        }));
        if (!grantOpen && api) {
          const selectionId = registrySelection.current + 1;
          registrySelection.current = selectionId;
          try {
            const opened = await api.openEntry(ref);
            if (
              registrySelection.current === selectionId &&
              opened.status !== "corrupt" &&
              openedEntryMatches(opened, ref)
            ) {
              grantIssuedAt.current = Date.now();
              if (opened.status === "granted")
                grantCache.current = {
                  ...grantCache.current,
                  [observationKey(ref)]: { grantHandle: opened.grantHandle, issuedAt: Date.now() },
                };
              setOpenedEntry(opened);
            }
          } catch {
            // Without a grant the page still renders the cached observation; content reads report unavailable.
          }
        }
        return;
      }
      if (!api) {
        setRegistryError({ message: t("errors.preloadUnavailable") });
        return;
      }
      const generation = registryGeneration.current;
      const selectionId = registrySelection.current + 1;
      registrySelection.current = selectionId;
      setRoute(nextRoute);
      setOpenedEntry(null);
      setObservations((current) => {
        const next = { ...current };
        delete next[observationKey(ref)];
        return next;
      });
      setRegistryError(null);
      beginRegistryOperation();
      try {
        const opened = await api.openEntry(ref);
        if (registrySelection.current !== selectionId || registryGeneration.current !== generation) return;
        if (opened.status === "corrupt") {
          clearRegistrySelection();
          setRegistry(opened);
          setRegistryError(null);
          return;
        }
        if (!openedEntryMatches(opened, ref)) {
          setRegistryError({ message: t("registry.responseIdentityMismatch") });
          return;
        }
        grantIssuedAt.current = Date.now();
        if (opened.status === "granted")
          grantCache.current = {
            ...grantCache.current,
            [observationKey(ref)]: { grantHandle: opened.grantHandle, issuedAt: Date.now() },
          };
        setOpenedEntry(opened);
        if (opened.status !== "granted") {
          return;
        }
        setObservationPending(ref, selectionId, true);
        let observation: ObservationResponse;
        try {
          observation =
            ref.kind === "project"
              ? await api.observeProject({ projectId: ref.id, grantHandle: opened.grantHandle })
              : await api.observeSource({ sourceId: ref.id, grantHandle: opened.grantHandle });
        } finally {
          setObservationPending(ref, selectionId, false);
        }
        if (registrySelection.current !== selectionId || registryGeneration.current !== generation) return;
        if (observation.status === "corrupt") {
          clearRegistrySelection();
          setRegistry(observation);
          setRegistryError(null);
          return;
        }
        if (!observationMatches(observation, ref)) {
          setRegistryError({ message: t("registry.responseIdentityMismatch") });
          return;
        }
        setObservations((current) => ({ ...current, [observationKey(ref)]: observation }));
        if (observation.status === "observed") {
          try {
            const hashed = await hashObservation(api, ref, opened.grantHandle, observation.observation);
            if (
              registrySelection.current === selectionId &&
              registryGeneration.current === generation &&
              hashed.status !== "corrupt"
            ) {
              setEntryIdentities((current) => ({ ...current, [observationKey(ref)]: hashed.observation }));
            }
          } catch {
            // Hashing failures are non-fatal and are recorded per artifact; the route observation still renders without identities.
          }
        }
      } catch (selectionError: unknown) {
        if (registrySelection.current === selectionId && registryGeneration.current === generation) {
          setRegistryError(readError(selectionError, t("registry.entryCouldNotOpen")));
        }
      } finally {
        endRegistryOperation();
      }
    },
    [
      canSelect,
      api,
      beginRegistryOperation,
      currentAuditReport,
      endRegistryOperation,
      observations,
      openedEntry,
      setObservationPending,
      t,
    ],
  );
}
