import type { BindingSnapshot, ResourceSnapshot, RootEvidence } from "../../domain/resource-catalogue";
import type { EntryRef, Observation, RegistryView } from "../../domain/project-source-registry";
import type { ObservationResponse } from "../../shared/registry-ipc";
import { observationKey } from "../app-helpers";

function sameEntry(left: EntryRef, right: EntryRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
function evidenceFor(
  entry: EntryRef,
  availability: "available" | "missing" | "inaccessible",
  current: ObservationResponse | undefined,
  audits: readonly Observation[],
  pending: boolean,
): RootEvidence {
  if (availability === "missing") return { status: "unavailable", reason: "missing" };
  if (availability === "inaccessible") return { status: "unavailable", reason: "inaccessible" };
  if (current) {
    if (current.status === "observed")
      return sameEntry(current.observation.subject, entry)
        ? { status: "observed", observation: current.observation }
        : { status: "unavailable", reason: "failed" };
    if (current.status === "missing" || current.status === "inaccessible")
      return sameEntry(current.subject, entry)
        ? { status: "unavailable", reason: current.status }
        : { status: "unavailable", reason: "failed" };
    return { status: "unavailable", reason: "failed" };
  }
  const audit = audits.find((observation) => sameEntry(observation.subject, entry));
  if (pending) return { status: "loading" };
  if (audit) return { status: "observed", observation: audit };
  return { status: "unobserved" };
}

export function createResourceSnapshot(
  input: Readonly<{
    registry: RegistryView;
    observations: Readonly<Record<string, ObservationResponse>>;
    auditObservations: readonly Observation[];
    pendingObservations: Readonly<Record<string, boolean>>;
    uses: BindingSnapshot;
  }>,
): ResourceSnapshot {
  const entries = [...input.registry.sources, ...input.registry.projects].filter(
    (entry) => entry.archivedAt === undefined,
  );
  return {
    registry: input.registry,
    uses: input.uses,
    roots: entries.map((entry) => {
      const key = observationKey(entry.ref);
      return {
        entry: entry.ref,
        evidence: evidenceFor(
          entry.ref,
          entry.availability,
          input.observations[key],
          input.auditObservations,
          input.pendingObservations[key] === true,
        ),
      };
    }),
  };
}
