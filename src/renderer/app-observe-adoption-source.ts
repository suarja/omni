import { activeWorkshop } from "../domain/source-roles";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { EntryRef, CorruptRegistryResult } from "../domain/project-source-registry";
import type { AuditObservation } from "./audit/audit-report";
import { hashObservation } from "./audit/use-audit-session";
import type { DesktopApi } from "../shared/ipc";
import type { ObservationResponse, RegistryViewResponse } from "../shared/registry-ipc";
import { observationKey, observationMatches, openedEntryMatches } from "./app-helpers";

type AdoptionSourceApi = Pick<DesktopApi, "openEntry" | "observeSource"> & Partial<Pick<DesktopApi, "hashArtifacts">>;

type Inputs = Readonly<{
  api: AdoptionSourceApi;
  registry: () => RegistryViewResponse | null;
  registryGeneration: MutableRefObject<number>;
  isCurrent: () => boolean;
  setObservations: Dispatch<SetStateAction<Readonly<Record<string, ObservationResponse>>>>;
  setEntryIdentities: Dispatch<SetStateAction<Readonly<Record<string, AuditObservation>>>>;
  grantCache?: MutableRefObject<Readonly<Record<string, Readonly<{ grantHandle: string; issuedAt: number }>>>>;
  grantIssuedAt?: MutableRefObject<number>;
  now?: () => number;
  onCorrupt?: (result: CorruptRegistryResult) => void;
  identityMismatchDiagnostic?: string;
  onIdentityMismatch?: () => void;
}>;

class SourceIdentityMismatchError extends Error {}

function isActiveWorkshop(registry: RegistryViewResponse | null, sourceId: string): boolean {
  if (registry?.status !== "ready") return false;
  const source = activeWorkshop(registry.registry);
  return Boolean(source && source.ref.id === sourceId && source.availability === "available");
}

function matchesObservation(
  response: ObservationResponse,
  entry: EntryRef,
): response is Extract<ObservationResponse, { status: "observed" }> {
  return (
    response.status === "observed" &&
    response.observation.subject.kind === entry.kind &&
    response.observation.subject.id === entry.id
  );
}

export async function observeAdoptionSource(
  sourceId: string,
  inputs: Inputs,
): Promise<Extract<ObservationResponse, { status: "observed" }>["observation"] | null> {
  const entry: EntryRef = { kind: "source", id: sourceId };
  const generation = inputs.registryGeneration.current;
  const isCurrent = (): boolean =>
    inputs.registryGeneration.current === generation &&
    inputs.isCurrent() &&
    isActiveWorkshop(inputs.registry(), sourceId);
  if (!isCurrent()) return null;

  try {
    const opened = await inputs.api.openEntry(entry);
    if (isCurrent() && opened.status === "corrupt") {
      inputs.onCorrupt?.(opened);
      return null;
    }
    if (!isCurrent()) return null;
    if (!openedEntryMatches(opened, entry))
      throw new SourceIdentityMismatchError(
        inputs.identityMismatchDiagnostic ?? "The local response did not match the selected root.",
      );
    if (opened.status !== "granted") return null;
    const response = await inputs.api.observeSource({ sourceId, grantHandle: opened.grantHandle });
    if (isCurrent() && response.status === "corrupt") {
      inputs.onCorrupt?.(response);
      return null;
    }
    if (!isCurrent()) return null;
    if (!observationMatches(response, entry))
      throw new SourceIdentityMismatchError(
        inputs.identityMismatchDiagnostic ?? "The local response did not match the selected root.",
      );
    if (!matchesObservation(response, entry)) return null;

    const key = observationKey(entry);
    const now = inputs.now ?? Date.now;
    const issuedAt = now();
    inputs.grantIssuedAt && (inputs.grantIssuedAt.current = issuedAt);
    if (inputs.grantCache)
      inputs.grantCache.current = {
        ...inputs.grantCache.current,
        [key]: { grantHandle: opened.grantHandle, issuedAt },
      };
    inputs.setObservations((current) => ({ ...current, [key]: response }));

    try {
      const hashed = await hashObservation(inputs.api as DesktopApi, entry, opened.grantHandle, response.observation);
      if (isCurrent() && hashed.status !== "corrupt")
        inputs.setEntryIdentities((current) => ({ ...current, [key]: hashed.observation }));
    } catch {
      // Source choices use the strict inventory; failed identity hashing must not block them.
    }
    return response.observation;
  } catch (error) {
    if (error instanceof SourceIdentityMismatchError && isCurrent()) {
      inputs.onIdentityMismatch?.();
      throw error;
    }
    return null;
  }
}
