import type { EntryRef, RegistryEntryView } from "../domain/project-source-registry";
import type { ObservationResponse, OpenEntryResponse } from "../shared/registry-ipc";

export type ActiveProjectContext = Readonly<{
  entry: RegistryEntryView<"project">;
  opened: Extract<OpenEntryResponse, { status: "granted" }>;
  observation: Extract<ObservationResponse, { status: "observed" }>;
}>;

export function createActiveProjectContext(
  entry: RegistryEntryView<"project">,
  opened: OpenEntryResponse,
  observation: ObservationResponse,
): ActiveProjectContext | null {
  if (opened.status !== "granted" || opened.entry.ref.kind !== "project" || opened.entry.ref.id !== entry.ref.id) {
    return null;
  }
  if (
    observation.status !== "observed" ||
    observation.observation.subject.kind !== "project" ||
    observation.observation.subject.id !== entry.ref.id
  ) {
    return null;
  }
  return { entry, opened, observation };
}

export function isUsableProjectContext(value: ActiveProjectContext | null): value is ActiveProjectContext {
  return value !== null && value.entry.ref.kind === "project";
}

export function sameProjectContext(context: ActiveProjectContext | null, ref: EntryRef): boolean {
  return context?.entry.ref.kind === "project" && ref.kind === "project" && context.entry.ref.id === ref.id;
}
