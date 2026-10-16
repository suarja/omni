import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { AuditObservation } from "./audit/audit-report";
import type { RegistryError } from "./registry/registry-error";
import type { EntryRef } from "../domain/project-source-registry";
import type { ObservationResponse, OpenEntryResponse } from "../shared/registry-ipc";
import { routeForDestination, type Destination, type Route } from "./navigation";

type State<T> = Dispatch<SetStateAction<T>>;

export type RegistrySelectionNavigationDeps = Readonly<{
  registryGeneration: { current: number };
  registrySelection: { current: number };
  setOpenedEntry: State<OpenEntryResponse | null>;
  setObservations: State<Readonly<Record<string, ObservationResponse>>>;
  setEntryIdentities: State<Readonly<Record<string, AuditObservation>>>;
}>;

export function clearRegistrySelectionEffect(deps: RegistrySelectionNavigationDeps): void {
  deps.registryGeneration.current += 1;
  deps.registrySelection.current += 1;
  deps.setOpenedEntry(null);
  deps.setObservations({});
  deps.setEntryIdentities({});
}

export function useClearRegistrySelection({
  registryGeneration,
  registrySelection,
  setOpenedEntry,
  setObservations,
  setEntryIdentities,
}: RegistrySelectionNavigationDeps): () => void {
  return useCallback(
    () =>
      clearRegistrySelectionEffect({
        registryGeneration,
        registrySelection,
        setOpenedEntry,
        setObservations,
        setEntryIdentities,
      }),
    [registryGeneration, registrySelection, setEntryIdentities, setObservations, setOpenedEntry],
  );
}

type DestinationNavigationDeps = Readonly<{
  setOpenedEntry: State<OpenEntryResponse | null>;
  setRoute: State<Route | null>;
  setRegistryError: State<RegistryError | null>;
}>;

export function useDestinationNavigation({
  setOpenedEntry,
  setRoute,
  setRegistryError,
}: DestinationNavigationDeps): (destination: Destination) => void {
  return useCallback(
    (destination: Destination): void => {
      setRoute(routeForDestination(destination));
      setRegistryError(null);
      setOpenedEntry(null);
    },
    [setOpenedEntry, setRoute, setRegistryError],
  );
}
