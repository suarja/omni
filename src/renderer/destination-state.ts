import type { EntryRef, RegistryEntryView, RegistryView, SourceEntryView } from "../domain/project-source-registry";
import type { AuditSessionState } from "./audit/use-audit-session";

export type DestinationAuditState = Pick<AuditSessionState, "status" | "report">;
type RegistryEntry = RegistryEntryView | SourceEntryView;

export function activeProjects(registry: RegistryView): readonly RegistryEntryView<"project">[] {
  return registry.projects.filter((entry) => entry.archivedAt === undefined);
}

export function entryForRef(registry: RegistryView, ref: EntryRef): RegistryEntry | undefined {
  return ref.kind === "project"
    ? registry.projects.find((entry) => entry.ref.id === ref.id)
    : registry.sources.find((entry) => entry.ref.id === ref.id);
}
