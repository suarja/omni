import type { EntryRef, RegistryView, SourceEntryView } from "../../domain/project-source-registry";
import type { AuditReport } from "./audit-report";

export type AuditSnapshot = Readonly<{
  report: AuditReport;
  registryFingerprint: string;
  selectedRefsKey: string;
}>;

export function selectedRefsKey(selectedRefs?: readonly EntryRef[]): string {
  if (selectedRefs === undefined) return "all";
  return [...new Set(selectedRefs.map(({ kind, id }) => `${kind}:${id}`))].sort().join(",");
}

export function registryObservationFingerprint(registry: RegistryView): string {
  const entries = [...registry.projects, ...registry.sources]
    .map(
      (entry) =>
        `${entry.ref.kind}:${entry.ref.id}:${entry.availability}:${entry.archivedAt ?? ""}${entry.ref.kind === "source" ? `:${(entry as SourceEntryView).ownership}` : ""}`,
    )
    .sort();
  return [registry.revision, ...entries].join("|");
}

export function readCurrentAuditReport(
  snapshot: AuditSnapshot | null,
  registry: RegistryView | null,
  selectedRefs?: readonly EntryRef[],
): AuditReport | null {
  if (registry === null || snapshot === null) return null;
  return snapshot.registryFingerprint === registryObservationFingerprint(registry) &&
    snapshot.selectedRefsKey === selectedRefsKey(selectedRefs)
    ? snapshot.report
    : null;
}
