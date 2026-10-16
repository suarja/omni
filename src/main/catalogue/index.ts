import { readFile } from "node:fs/promises";

import { artifactName } from "../../domain/identity";
import { tagsForText } from "../../domain/stack-tags";
import { resolveResource, type ResourceOptions } from "../omni-resources";
import type { RegistryIpcServices } from "../registry-ipc";
import type { CatalogueEntry } from "./rank";

const SNAPSHOT_RELATIVE_PATH = "packages/omni-catalogue/catalogue.json";
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export type CatalogueSnapshotEntry = Readonly<{
  source: "skills.sh";
  ownerRepo: string;
  skill: string;
  name: string;
  description?: string;
  path: string | null;
  url?: string;
  tags: readonly string[];
  installs: number;
  weeklyInstalls: readonly number[];
  official: boolean;
  fetchedAt: string;
  hash?: string;
}>;

export type CatalogueSnapshot = Readonly<{
  builtAt: string;
  source: "skills.sh";
  entries: readonly CatalogueSnapshotEntry[];
}>;

/** What the catalogue index needs from a marketplace skill artifact — see `marketplaceSkills` below. */
export type MarketplaceSkillEntry = Readonly<{ name: string; description?: string; packageName: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSnapshotEntry(value: unknown): CatalogueSnapshotEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { ownerRepo, skill, name, description, path, url, tags, installs, weeklyInstalls, official, fetchedAt, hash } =
    value;
  if (typeof ownerRepo !== "string" || typeof skill !== "string" || typeof name !== "string") return undefined;
  if (path !== null && typeof path !== "string") return undefined;
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) return undefined;
  return {
    source: "skills.sh",
    ownerRepo,
    skill,
    name,
    ...(typeof description === "string" ? { description } : {}),
    path,
    ...(typeof url === "string" ? { url } : {}),
    tags,
    installs: typeof installs === "number" ? installs : 0,
    weeklyInstalls: Array.isArray(weeklyInstalls) ? weeklyInstalls.filter((n) => typeof n === "number") : [],
    official: official === true,
    fetchedAt: typeof fetchedAt === "string" ? fetchedAt : "",
    ...(typeof hash === "string" ? { hash } : {}),
  };
}

/**
 * Reads and loosely validates the bundled snapshot (`packages/omni-catalogue/catalogue.json`,
 * built by `pnpm --filter @omni/catalogue build`). A malformed or missing snapshot yields an
 * empty catalogue rather than failing the whole Library — the Catalogue tab then simply shows no
 * skills.sh rows; the personal and external marketplaces are unaffected.
 */
export async function loadCatalogueSnapshot(options: ResourceOptions = {}): Promise<CatalogueSnapshot> {
  try {
    const path = resolveResource(SNAPSHOT_RELATIVE_PATH, options);
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_SNAPSHOT_BYTES) return { builtAt: "", source: "skills.sh", entries: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return { builtAt: "", source: "skills.sh", entries: [] };
    const entries = parsed.entries.map(readSnapshotEntry).filter((entry): entry is CatalogueSnapshotEntry => !!entry);
    return {
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "",
      source: "skills.sh",
      entries,
    };
  } catch {
    return { builtAt: "", source: "skills.sh", entries: [] };
  }
}

/**
 * Every skill artifact across the active personal and external marketplaces, tagged the same way
 * as a catalogue snapshot entry (`tagsForText` on its name + description) — the input `rank`
 * needs to apply the already-in-marketplace bonus. Registered sources that fail to observe (an
 * archived, missing, or inaccessible root) are skipped rather than failing the whole search.
 */
export async function marketplaceSkills(registry: RegistryIpcServices): Promise<readonly MarketplaceSkillEntry[]> {
  const view = await registry.listRegistry();
  if (view.status !== "ready") return [];
  const activeSources = view.registry.sources.filter(
    (source) => source.archivedAt === undefined && source.availability === "available",
  );
  const observations = await Promise.all(
    activeSources.map((source) => registry.observeRegisteredEntry({ kind: "source", id: source.ref.id })),
  );
  const skills: MarketplaceSkillEntry[] = [];
  for (const observation of observations) {
    if (observation.status !== "observed") continue;
    const packagesById = new Map(observation.observation.inventory.packages?.map((item) => [item.id, item]) ?? []);
    for (const artifact of observation.observation.inventory.artifacts) {
      if (artifact.kind !== "skill") continue;
      const packageInfo = artifact.packageId ? packagesById.get(artifact.packageId) : undefined;
      skills.push({
        name: artifactName({ kind: artifact.kind, provenance: { relativePath: artifact.relativePath } }, packageInfo),
        ...(artifact.summary ? { description: artifact.summary } : {}),
        packageName: packageInfo?.displayName ?? artifact.displayPath,
      });
    }
  }
  return skills;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function toCatalogueEntry(entry: CatalogueSnapshotEntry): CatalogueEntry {
  return {
    source: "skills.sh",
    ownerRepo: entry.ownerRepo,
    skill: entry.skill,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    path: entry.path,
    tags: entry.tags,
    installs: entry.installs,
    official: entry.official,
    ...(entry.url ? { url: entry.url } : {}),
  };
}

/**
 * Merges the skills.sh snapshot with the marketplace's own skills into one list, cheap to
 * recompute on every search (no cache file, per Brief 34b): a snapshot entry whose name matches a
 * marketplace skill becomes a `"marketplace"`-sourced row (so the ranker's already-in-marketplace
 * bonus applies and the row shows what plugin already has it); a marketplace skill with no
 * matching snapshot entry has nowhere to link to in this index and is left for the Library's
 * other tabs.
 */
export function buildCatalogueIndex(
  snapshot: CatalogueSnapshot,
  installed: readonly MarketplaceSkillEntry[],
): readonly CatalogueEntry[] {
  const installedByName = new Map<string, MarketplaceSkillEntry>();
  for (const skill of installed) {
    const key = normalizeName(skill.name);
    if (!installedByName.has(key)) installedByName.set(key, skill);
  }
  return snapshot.entries.map((entry) => {
    const match = installedByName.get(normalizeName(entry.name));
    if (!match) return toCatalogueEntry(entry);
    return { ...toCatalogueEntry(entry), source: "marketplace" as const, packageName: match.packageName };
  });
}

/** Tags a free-text description the same way the build script tags a snapshot entry. */
export function tagCatalogueText(name: string, description: string | undefined): readonly string[] {
  return tagsForText(`${name} ${description ?? ""}`);
}
