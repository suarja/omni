import { ipcMain } from "electron";

import {
  CATALOGUE_IPC_CHANNELS,
  parseCatalogueEntryRequest,
  parseCataloguePrepareImportRequest,
  parseCatalogueSearchRequest,
  type CatalogueEntryResponse,
  type CatalogueEntryView,
  type CataloguePrepareImportResponse,
  type CatalogueSearchResponse,
} from "../../shared/catalogue-ipc";
import type { StackProfile } from "../../domain/stack-profile";
import type { RegistryIpcServices } from "../registry-ipc";
import { createStackProfileStore, stackProfileStoreFilePath, type StackProfileStore } from "../stack-profile-ipc";
import {
  catalogueGrantSourceId,
  catalogueImportRootIdentity,
  fetchCatalogueSkillMd,
  prepareCatalogueImportFiles,
} from "./cache";
import {
  buildCatalogueIndex,
  loadCatalogueSnapshot,
  marketplaceSkills,
  type CatalogueSnapshot,
  type CatalogueSnapshotEntry,
} from "./index";
import { rank, type CatalogueEntry } from "./rank";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;

const DEFAULT_SEARCH_LIMIT = 30;

function toEntryView(entry: CatalogueEntry): CatalogueEntryView {
  return {
    source: entry.source,
    ownerRepo: entry.ownerRepo,
    skill: entry.skill,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    hasSkillMd: entry.path !== null,
    tags: entry.tags,
    installs: entry.installs,
    official: entry.official,
    ...(entry.packageName ? { packageName: entry.packageName } : {}),
  };
}

function findSnapshotEntry(
  snapshot: CatalogueSnapshot,
  ownerRepo: string,
  skill: string,
): CatalogueSnapshotEntry | undefined {
  return snapshot.entries.find((entry) => entry.ownerRepo === ownerRepo && entry.skill === skill);
}

async function loadSnapshotOnce(
  cached: { value?: CatalogueSnapshot },
  options: Parameters<typeof loadCatalogueSnapshot>[0],
): Promise<CatalogueSnapshot> {
  if (!cached.value) cached.value = await loadCatalogueSnapshot(options);
  return cached.value;
}

export type CatalogueIpcOptions = Readonly<{
  userDataPath: string;
  stackProfileStore?: StackProfileStore;
  resourceOptions?: Parameters<typeof loadCatalogueSnapshot>[0];
}>;

export function registerCatalogueIpcHandlers(
  assertTrustedSender: SenderGuard,
  registry: RegistryIpcServices,
  options: CatalogueIpcOptions,
): void {
  const stackProfiles =
    options.stackProfileStore ?? createStackProfileStore(stackProfileStoreFilePath(options.userDataPath));
  // Loaded once per process: the bundled snapshot is a fixed asset of this app build, never
  // written at run time, so re-reading it on every search would only cost time, not correctness.
  const snapshotCache: { value?: CatalogueSnapshot } = {};

  ipcMain.handle(CATALOGUE_IPC_CHANNELS.search, async (event, raw: unknown): Promise<CatalogueSearchResponse> => {
    assertTrustedSender(event);
    const request = parseCatalogueSearchRequest(raw);
    const snapshot = await loadSnapshotOnce(snapshotCache, options.resourceOptions);
    const installed = await marketplaceSkills(registry).catch(() => []);
    const index = buildCatalogueIndex(snapshot, installed);
    const profile: StackProfile | null = request.projectId
      ? ((await stackProfiles.get(request.projectId).catch(() => undefined)) ?? null)
      : null;
    const tagFilter = request.tags?.length ? new Set(request.tags) : undefined;
    const candidates = tagFilter ? index.filter((entry) => entry.tags.some((tag) => tagFilter.has(tag))) : index;
    const ranked = rank(profile, candidates, request.query);
    const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
    return {
      status: "ready",
      results: ranked.slice(0, limit).map((result) => ({
        entry: toEntryView(result.entry),
        score: result.score,
        matchedTags: result.matchedTags,
      })),
    };
  });

  ipcMain.handle(CATALOGUE_IPC_CHANNELS.entry, async (event, raw: unknown): Promise<CatalogueEntryResponse> => {
    assertTrustedSender(event);
    const request = parseCatalogueEntryRequest(raw);
    const snapshot = await loadSnapshotOnce(snapshotCache, options.resourceOptions);
    const snapshotEntry = findSnapshotEntry(snapshot, request.ownerRepo, request.skill);
    if (!snapshotEntry) return { status: "not-found" };
    const installed = await marketplaceSkills(registry).catch(() => []);
    const [entry] = buildCatalogueIndex({ ...snapshot, entries: [snapshotEntry] }, installed);
    const skillMd = await fetchCatalogueSkillMd(snapshotEntry, options.userDataPath);
    return { status: "ready", entry: toEntryView(entry!), skillMd };
  });

  ipcMain.handle(
    CATALOGUE_IPC_CHANNELS.prepareImport,
    async (event, raw: unknown): Promise<CataloguePrepareImportResponse> => {
      assertTrustedSender(event);
      const request = parseCataloguePrepareImportRequest(raw);
      const snapshot = await loadSnapshotOnce(snapshotCache, options.resourceOptions);
      const snapshotEntry = findSnapshotEntry(snapshot, request.ownerRepo, request.skill);
      if (!snapshotEntry || !snapshotEntry.path)
        return { status: "unavailable", reason: "No SKILL.md was found for this skill." };
      const skillMd = await fetchCatalogueSkillMd(snapshotEntry, options.userDataPath);
      if (skillMd.status !== "ready") return skillMd;
      const prepared = await prepareCatalogueImportFiles(snapshotEntry, skillMd.content, options.userDataPath);
      const identity = await catalogueImportRootIdentity(prepared.root);
      const sourceId = catalogueGrantSourceId(request.ownerRepo, request.skill);
      const grantHandle = registry.issue({
        subject: { kind: "source", id: sourceId },
        root: identity.canonicalPath,
        device: identity.device,
        inode: identity.inode,
      });
      return { status: "ready", sourceId, grantHandle, relativePath: prepared.relativePath };
    },
  );
}
