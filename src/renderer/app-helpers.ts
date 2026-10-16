import type { EntryRef } from "../domain/project-source-registry";
import type { DesktopApi } from "../shared/ipc";
import type { ObservationResponse, OpenEntryResponse } from "../shared/registry-ipc";
import type { RegistryError } from "./registry/registry-error";

type OmniWindow = Window & { omni?: DesktopApi };

export function observationKey(ref: EntryRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function getDesktopApi(): DesktopApi {
  const api = (window as OmniWindow).omni;
  if (!api) throw new Error("Omni preload API is unavailable.");
  return api;
}
export function readError(error: unknown, fallback: string): RegistryError {
  const raw = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (!raw) return { message: fallback };
  const detail = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
  return { message: fallback, ...(detail !== fallback ? { detail } : {}) };
}

export function openedEntryMatches(opened: OpenEntryResponse, ref: EntryRef): boolean {
  return opened.status !== "corrupt" && opened.entry.ref.kind === ref.kind && opened.entry.ref.id === ref.id;
}

export function observationMatches(observation: ObservationResponse, ref: EntryRef): boolean {
  if (observation.status === "corrupt") return false;
  const subject = observation.status === "observed" ? observation.observation.subject : observation.subject;
  return subject.kind === ref.kind && subject.id === ref.id;
}
