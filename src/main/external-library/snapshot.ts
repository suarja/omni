import { resolve } from "node:path";
import type { ExternalLibraryObservation } from "./reader";
import { readExternalRegistry, summarizeExternalSource } from "./reader";
import { detectExternalUses } from "./detection";
import type { ExternalReadCopyOptions } from "./read-copy";
import type { ExternalSourceDetails } from "../../shared/external-library-ipc";
import type { ExternalSourcesStore } from "./store";

// Project readers share the running service's completed observation for this profile.
const snapshots = new Map<string, ExternalLibraryObservation>();
export function publishExternalSnapshot(userDataPath: string, observation: ExternalLibraryObservation): void {
  snapshots.set(resolve(userDataPath), observation);
}
export function readExternalSnapshot(userDataPath: string): ExternalLibraryObservation | undefined {
  return snapshots.get(resolve(userDataPath));
}
export function clearExternalSnapshot(userDataPath: string): void {
  snapshots.delete(resolve(userDataPath));
}
export async function readPersistedExternalSnapshot(
  options: ExternalReadCopyOptions,
  store: ExternalSourcesStore,
): Promise<ExternalLibraryObservation> {
  const records = (await store.read()).sources;
  const detection = await detectExternalUses(await readExternalRegistry(options));
  const sources: ExternalSourceDetails[] = records.map((record) => ({
    source: summarizeExternalSource(record.repo, record.repo, record),
    skills: [],
    uses: [],
  }));
  for (const locked of detection.uses) {
    const source = sources.find((source) => source.source!.id === locked.entry.source.locator);
    if (!source) continue;
    const use = {
      id: locked.id,
      sourceId: locked.entry.source.locator,
      projectId: locked.projectId,
      projectName: locked.projectName,
      skillKey: locked.entry.skillKey,
      lockHash: locked.entry.recordedHash,
      state: "unknown" as const,
      sourceChanged: false,
      base: { status: "unknown" as const, reason: "The first source check has not completed." },
    };
    source.uses.push(use);
    source.source!.counts.unknown++;
    if (!source.source!.projects.some((project) => project.id === locked.projectId))
      source.source!.projects.push({ id: locked.projectId, name: locked.projectName });
  }
  return {
    sources,
    lockedUses: detection.uses,
    roots: new Map(),
    observations: new Map(),
    diagnostics: detection.diagnostics.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
  };
}
