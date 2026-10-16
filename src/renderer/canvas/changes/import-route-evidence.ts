import type { EntryRef, Observation } from "../../../domain/project-source-registry";
import type { ObservedArtifact } from "../../../domain/inventory";
import type { RootEvidence } from "../../../domain/resource-catalogue";
import type { ObservationResponse } from "../../../shared/registry-ipc";

function matchesEntry(observation: Observation, entry: EntryRef): boolean {
  return observation.subject.kind === entry.kind && observation.subject.id === entry.id;
}

export function findImportObservation(
  input: Readonly<{
    entry: EntryRef;
    current: ObservationResponse | null;
    cached?: ObservationResponse;
    root?: RootEvidence;
    audits?: readonly Observation[];
  }>,
): Observation | null {
  if (input.current?.status === "observed" && matchesEntry(input.current.observation, input.entry))
    return input.current.observation;
  if (
    input.current &&
    (input.current.status === "missing" || input.current.status === "inaccessible") &&
    input.current.subject.kind === input.entry.kind &&
    input.current.subject.id === input.entry.id
  )
    return null;
  if (input.cached)
    return input.cached.status === "observed" && matchesEntry(input.cached.observation, input.entry)
      ? input.cached.observation
      : null;
  if (input.root)
    return input.root.status === "observed" && matchesEntry(input.root.observation, input.entry)
      ? input.root.observation
      : null;
  return input.audits?.find((observation) => matchesEntry(observation, input.entry)) ?? null;
}

export function findImportArtifact(observation: Observation | null, requestedPath: string): ObservedArtifact | null {
  const path = requestedPath.replaceAll("\\", "/").replace(/\/+$/u, "");
  return (
    observation?.inventory.artifacts.find((artifact) =>
      [artifact.relativePath, ...artifact.projectionPaths].some((candidate) => {
        const normalized = candidate.replaceAll("\\", "/").replace(/\/+$/u, "");
        return normalized === path || (artifact.kind === "skill" && normalized === `${path}/SKILL.md`);
      }),
    ) ?? null
  );
}
