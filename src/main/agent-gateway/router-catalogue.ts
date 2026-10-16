// Read-only agent gateway methods for the catalogue and the stack profile (Brief 34c): the same
// deterministic pieces the Suggested-for-this-project card and the Catalogue tab already use —
// `getStackProfile` (Brief 34a), `loadCatalogueSnapshot` / `buildCatalogueIndex` / `rank` (Brief
// 34b) — exposed to an agent's own session through `omni_stack_profile`, `omni_catalog_search`,
// `omni_suggest`, and `omni_session`. No model, no network, bounded inputs; writes still go
// through `omni_preview_*` + consent.

import { artifactName } from "../../domain/identity";
import type { StackProfile } from "../../domain/stack-profile";
import type { ActivitySnapshot, AgentSession } from "../../shared/activity-ipc";
import { buildActivitySnapshot } from "../activity-snapshot";
import {
  buildCatalogueIndex,
  loadCatalogueSnapshot,
  marketplaceSkills,
  type CatalogueSnapshot,
} from "../catalogue/index";
import { rank, type CatalogueEntry } from "../catalogue/rank";
import type { RegistryIpcServices } from "../registry-ipc";
import {
  createStackProfileStore,
  getStackProfile,
  stackProfileStoreFilePath,
  type StackProfileStore,
} from "../stack-profile-ipc";
import { fail, id, keys, object, text } from "./router-inputs";

const CATALOGUE_METHODS = new Set(["stack_profile", "catalog_search", "suggest", "session"]);
const MAX_QUERY_LENGTH = 200;
const MAX_TAGS = 20;
const MAX_SESSION_ID_LENGTH = 256;
const CATALOG_SEARCH_MAX_LIMIT = 50;
const CATALOG_SEARCH_DEFAULT_LIMIT = 20;
const SUGGEST_MAX_LIMIT = 20;
const SUGGEST_DEFAULT_LIMIT = 8;

export type AgentCatalogueEntryView = Readonly<{
  name: string;
  ownerRepo: string;
  skill: string;
  description?: string;
  tags: readonly string[];
  installs: number;
  official: boolean;
  inMarketplace: boolean;
  url?: string;
}>;
export type AgentCatalogSearchResponse = Readonly<{ status: "ready"; results: readonly AgentCatalogueEntryView[] }>;
export type AgentSuggestEntryView = AgentCatalogueEntryView &
  Readonly<{ why: readonly string[]; alreadyInProject: boolean }>;
export type AgentSuggestResponse = Readonly<{ status: "ready"; results: readonly AgentSuggestEntryView[] }>;
export type AgentSessionResponse =
  Readonly<{ status: "found"; session: AgentSession }> | Readonly<{ status: "missing" }>;

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function tagId(value: unknown): string {
  const result = text(value, "Catalogue tag id", 64);
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(result)) throw fail("Catalogue tag id is malformed.");
  return result;
}

function optionalTags(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw fail("Catalogue tags must be an array.");
  if (value.length > MAX_TAGS) throw fail(`Catalogue tags must be at most ${MAX_TAGS}.`);
  const tags = value.map(tagId);
  if (new Set(tags).size !== tags.length) throw fail("Catalogue tags must be unique.");
  return tags;
}

function optionalProjectId(value: unknown): string | undefined {
  return value === undefined ? undefined : id(value, "Project id");
}

function boundedLimit(value: unknown, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max)
    throw fail(`Limit must be an integer between 1 and ${max}.`);
  return value;
}

/** Throws when `projectId` names no active, registered project — the "unknown project" guard every method below shares. */
async function requireProject(registry: RegistryIpcServices, projectId: string): Promise<void> {
  const result = await registry.listRegistry();
  if (result.status !== "ready") throw fail("The registry is unavailable.");
  const found = result.registry.projects.some(
    (project) => project.ref.id === projectId && project.archivedAt === undefined,
  );
  if (!found) throw fail("Unknown project.");
}

function toAgentEntry(entry: CatalogueEntry): AgentCatalogueEntryView {
  return {
    name: entry.name,
    ownerRepo: entry.ownerRepo,
    skill: entry.skill,
    ...(entry.description ? { description: entry.description } : {}),
    tags: entry.tags,
    installs: entry.installs,
    official: entry.official,
    inMarketplace: entry.source === "marketplace",
    ...(entry.url ? { url: entry.url } : {}),
  };
}

/** The names (lower-cased) of the skill artifacts already observed in this project — the same "compare by skill name" the Suggested-for-this-project card uses to exclude what the project already has. */
async function projectSkillNames(registry: RegistryIpcServices, projectId: string): Promise<ReadonlySet<string>> {
  const observed = await registry.observeRegisteredEntry({ kind: "project", id: projectId });
  if (observed.status !== "observed") return new Set();
  return new Set(
    observed.observation.inventory.artifacts
      .filter((artifact) => artifact.kind === "skill")
      .map((artifact) =>
        normalizeName(artifactName({ kind: artifact.kind, provenance: { relativePath: artifact.relativePath } })),
      ),
  );
}

export type CatalogueRouterOptions = Readonly<{
  userDataPath: string;
  registry: RegistryIpcServices;
  stackProfileStore?: StackProfileStore;
  resourceOptions?: Parameters<typeof loadCatalogueSnapshot>[0];
  now?: () => string;
  activitySnapshot?: () => Promise<ActivitySnapshot>;
}>;

export type CatalogueRouter = Readonly<{ handle(method: string, params: unknown): Promise<unknown> | undefined }>;

export function createCatalogueRouter(options: CatalogueRouterOptions): CatalogueRouter {
  const stackProfiles =
    options.stackProfileStore ?? createStackProfileStore(stackProfileStoreFilePath(options.userDataPath));
  // Recomputed per call, like the Catalogue tab's own search handler: the bundled snapshot never
  // changes at run time, so re-reading it costs time, never correctness.
  const buildIndex = async (): Promise<readonly CatalogueEntry[]> => {
    const snapshot: CatalogueSnapshot = await loadCatalogueSnapshot(options.resourceOptions);
    const installed = await marketplaceSkills(options.registry).catch(() => []);
    return buildCatalogueIndex(snapshot, installed);
  };

  const stackProfileMethod = async (params: unknown): Promise<unknown> => {
    const request = object(params, "stack_profile parameters");
    keys(request, ["projectId"], "stack_profile parameters");
    const projectId = id(request.projectId, "Project id");
    await requireProject(options.registry, projectId);
    return getStackProfile(projectId, options.registry, stackProfiles, {});
  };

  const catalogSearchMethod = async (params: unknown): Promise<AgentCatalogSearchResponse> => {
    const request = object(params, "catalog_search parameters");
    keys(request, ["query", "tags", "projectId", "limit"], "catalog_search parameters");
    const query = request.query === undefined ? undefined : text(request.query, "Catalogue query", MAX_QUERY_LENGTH);
    const tags = optionalTags(request.tags);
    const projectId = optionalProjectId(request.projectId);
    if (projectId) await requireProject(options.registry, projectId);
    const limit = boundedLimit(request.limit, CATALOG_SEARCH_MAX_LIMIT, CATALOG_SEARCH_DEFAULT_LIMIT);
    const entries = await buildIndex();
    const tagFilter = tags?.length ? new Set(tags) : undefined;
    const candidates = tagFilter ? entries.filter((entry) => entry.tags.some((tag) => tagFilter.has(tag))) : entries;
    const profile: StackProfile | null = projectId
      ? ((await stackProfiles.get(projectId).catch(() => undefined)) ?? null)
      : null;
    const ranked = rank(profile, candidates, query);
    return { status: "ready", results: ranked.slice(0, limit).map((result) => toAgentEntry(result.entry)) };
  };

  const suggestMethod = async (params: unknown): Promise<AgentSuggestResponse> => {
    const request = object(params, "suggest parameters");
    keys(request, ["projectId", "limit"], "suggest parameters");
    const projectId = id(request.projectId, "Project id");
    await requireProject(options.registry, projectId);
    const limit = boundedLimit(request.limit, SUGGEST_MAX_LIMIT, SUGGEST_DEFAULT_LIMIT);
    const [entries, existingNames] = await Promise.all([buildIndex(), projectSkillNames(options.registry, projectId)]);
    const profile: StackProfile | null = (await stackProfiles.get(projectId).catch(() => undefined)) ?? null;
    const ranked = rank(profile, entries);
    return {
      status: "ready",
      results: ranked.slice(0, limit).map((result) => ({
        ...toAgentEntry(result.entry),
        why: result.matchedTags,
        alreadyInProject: existingNames.has(normalizeName(result.entry.name)),
      })),
    };
  };

  const sessionMethod = async (params: unknown): Promise<AgentSessionResponse> => {
    const request = object(params, "session parameters");
    keys(request, ["sessionId"], "session parameters");
    const sessionId = text(request.sessionId, "Session id", MAX_SESSION_ID_LENGTH);
    const snapshot = await (options.activitySnapshot
      ? options.activitySnapshot()
      : buildActivitySnapshot({ userDataPath: options.userDataPath, omniPid: process.pid }));
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    return session ? { status: "found", session } : { status: "missing" };
  };

  return {
    handle: (method: string, params: unknown): Promise<unknown> | undefined => {
      if (!CATALOGUE_METHODS.has(method)) return undefined;
      if (method === "stack_profile") return stackProfileMethod(params);
      if (method === "catalog_search") return catalogSearchMethod(params);
      if (method === "suggest") return suggestMethod(params);
      return sessionMethod(params);
    },
  };
}
