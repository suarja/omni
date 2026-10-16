// IPC contract for the Catalogue tab (Brief 34b): a read-only search/entry pair backed by the
// merged index (`src/main/catalogue/index.ts`, `rank.ts`) plus a narrow bridge that prepares an
// "Add to my marketplace…" import through the existing import-artifact operation
// (`src/main/operations-import.ts`) — this file never writes anything itself.

export const CATALOGUE_IPC_CHANNELS = {
  search: "omni:catalogue:search",
  entry: "omni:catalogue:entry",
  prepareImport: "omni:catalogue:prepare-import",
} as const;

export type CatalogueEntrySource = "skills.sh" | "marketplace";

export type CatalogueEntryView = Readonly<{
  source: CatalogueEntrySource;
  ownerRepo: string;
  skill: string;
  name: string;
  description?: string;
  hasSkillMd: boolean;
  tags: readonly string[];
  installs: number;
  official: boolean;
  packageName?: string;
}>;

export type CatalogueSearchRequest = Readonly<{
  query?: string;
  tags?: readonly string[];
  projectId?: string;
  limit?: number;
}>;

export type CatalogueSearchResultView = Readonly<{
  entry: CatalogueEntryView;
  score: number;
  matchedTags: readonly string[];
}>;

export type CatalogueSearchResponse = Readonly<{ status: "ready"; results: readonly CatalogueSearchResultView[] }>;

export type CatalogueEntryRequest = Readonly<{ ownerRepo: string; skill: string }>;

export type CatalogueSkillMdState =
  | Readonly<{ status: "ready"; content: string }>
  | Readonly<{ status: "offline" }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type CatalogueEntryResponse =
  | Readonly<{ status: "ready"; entry: CatalogueEntryView; skillMd: CatalogueSkillMdState }>
  | Readonly<{ status: "not-found" }>;

export type CataloguePrepareImportRequest = Readonly<{ ownerRepo: string; skill: string }>;

export type CataloguePrepareImportResponse =
  | Readonly<{ status: "ready"; sourceId: string; grantHandle: string; relativePath: string }>
  | Readonly<{ status: "offline" }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export interface CatalogueDesktopApi {
  searchCatalogue(request: CatalogueSearchRequest): Promise<CatalogueSearchResponse>;
  getCatalogueEntry(request: CatalogueEntryRequest): Promise<CatalogueEntryResponse>;
  prepareCatalogueImport(request: CataloguePrepareImportRequest): Promise<CataloguePrepareImportResponse>;
}

const MAX_QUERY_LENGTH = 200;
const MAX_TAGS = 20;
const MAX_LIMIT = 100;

type RecordValue = Record<string, unknown>;

function assertRecord(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function assertKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label} has an unexpected field "${key}".`);
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

/** True if `text` contains a C0 or C1 control character (kept out of every opaque handle and path). */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function readOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const text = readText(value, label);
  if (text.length > maxLength || /[\r\n]/.test(text)) throw new Error(`${label} is too long or unsafe.`);
  return text;
}

function readId(value: unknown, label: string): string {
  const id = readText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`${label} is malformed.`);
  return id;
}

function readOwnerRepo(value: unknown): string {
  const text = readText(value, "Owner/repo");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(text))
    throw new Error('Owner/repo must be a GitHub "owner/repo" pair.');
  return text;
}

function readTagId(value: unknown): string {
  const id = readText(value, "Catalogue tag id");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Catalogue tag id is malformed.");
  return id;
}

function readTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Catalogue tags must be an array.");
  if (value.length > MAX_TAGS) throw new Error(`Catalogue tags must be at most ${MAX_TAGS}.`);
  const tags = value.map(readTagId);
  if (new Set(tags).size !== tags.length) throw new Error("Catalogue tags must be unique.");
  return tags;
}

function readLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
    throw new Error(`Catalogue search limit must be an integer between 1 and ${MAX_LIMIT}.`);
  return value;
}

function readInstalls(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Catalogue installs must be a non-negative number.");
  return value;
}

function readScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Catalogue score must be a finite number.");
  return value;
}

export function parseCatalogueSearchRequest(value: unknown): CatalogueSearchRequest {
  const request = assertRecord(value, "Catalogue search request");
  assertKeys(request, ["query", "tags", "projectId", "limit"], "Catalogue search request");
  return {
    ...(request.query === undefined
      ? {}
      : { query: readOptionalText(request.query, "Catalogue query", MAX_QUERY_LENGTH) }),
    ...(request.tags === undefined ? {} : { tags: readTags(request.tags) }),
    ...(request.projectId === undefined ? {} : { projectId: readId(request.projectId, "Project id") }),
    ...(request.limit === undefined ? {} : { limit: readLimit(request.limit) }),
  };
}

function parseCatalogueEntryView(value: unknown): CatalogueEntryView {
  const entry = assertRecord(value, "Catalogue entry");
  assertKeys(
    entry,
    [
      "source",
      "ownerRepo",
      "skill",
      "name",
      "description",
      "hasSkillMd",
      "tags",
      "installs",
      "official",
      "packageName",
    ],
    "Catalogue entry",
  );
  if (entry.source !== "skills.sh" && entry.source !== "marketplace")
    throw new Error("Catalogue entry source is invalid.");
  if (typeof entry.hasSkillMd !== "boolean") throw new Error("Catalogue entry hasSkillMd must be a boolean.");
  if (typeof entry.official !== "boolean") throw new Error("Catalogue entry official must be a boolean.");
  if (!Array.isArray(entry.tags)) throw new Error("Catalogue entry tags must be an array.");
  return {
    source: entry.source,
    ownerRepo: readOwnerRepo(entry.ownerRepo),
    skill: readId(entry.skill, "Catalogue skill id"),
    name: readOptionalText(entry.name, "Catalogue entry name", 200) ?? "",
    ...(entry.description === undefined
      ? {}
      : { description: readOptionalText(entry.description, "Catalogue entry description", 2000) }),
    hasSkillMd: entry.hasSkillMd,
    tags: entry.tags.map(readTagId),
    installs: readInstalls(entry.installs),
    official: entry.official,
    ...(entry.packageName === undefined
      ? {}
      : { packageName: readOptionalText(entry.packageName, "Catalogue package name", 200) }),
  };
}

export function parseCatalogueSearchResponse(value: unknown): CatalogueSearchResponse {
  const response = assertRecord(value, "Catalogue search response");
  assertKeys(response, ["status", "results"], "Catalogue search response");
  if (response.status !== "ready") throw new Error("Catalogue search response status is invalid.");
  if (!Array.isArray(response.results)) throw new Error("Catalogue search results must be an array.");
  return {
    status: "ready",
    results: response.results.map((raw) => {
      const result = assertRecord(raw, "Catalogue search result");
      assertKeys(result, ["entry", "score", "matchedTags"], "Catalogue search result");
      if (!Array.isArray(result.matchedTags)) throw new Error("Catalogue matched tags must be an array.");
      return {
        entry: parseCatalogueEntryView(result.entry),
        score: readScore(result.score),
        matchedTags: result.matchedTags.map(readTagId),
      };
    }),
  };
}

export function parseCatalogueEntryRequest(value: unknown): CatalogueEntryRequest {
  const request = assertRecord(value, "Catalogue entry request");
  assertKeys(request, ["ownerRepo", "skill"], "Catalogue entry request");
  return { ownerRepo: readOwnerRepo(request.ownerRepo), skill: readId(request.skill, "Catalogue skill id") };
}

function parseSkillMdState(value: unknown): CatalogueSkillMdState {
  const state = assertRecord(value, "Catalogue SKILL.md state");
  if (state.status === "ready") {
    assertKeys(state, ["status", "content"], "Catalogue SKILL.md state");
    if (typeof state.content !== "string") throw new Error("Catalogue SKILL.md content must be a string.");
    return { status: "ready", content: state.content };
  }
  if (state.status === "offline") {
    assertKeys(state, ["status"], "Catalogue SKILL.md state");
    return { status: "offline" };
  }
  if (state.status === "unavailable") {
    assertKeys(state, ["status", "reason"], "Catalogue SKILL.md state");
    return { status: "unavailable", reason: readOptionalText(state.reason, "Catalogue SKILL.md reason", 240) ?? "" };
  }
  throw new Error("Catalogue SKILL.md state status is invalid.");
}

export function parseCatalogueEntryResponse(value: unknown): CatalogueEntryResponse {
  const response = assertRecord(value, "Catalogue entry response");
  if (response.status === "not-found") {
    assertKeys(response, ["status"], "Catalogue entry response");
    return { status: "not-found" };
  }
  if (response.status === "ready") {
    assertKeys(response, ["status", "entry", "skillMd"], "Catalogue entry response");
    return {
      status: "ready",
      entry: parseCatalogueEntryView(response.entry),
      skillMd: parseSkillMdState(response.skillMd),
    };
  }
  throw new Error("Catalogue entry response status is invalid.");
}

export function parseCataloguePrepareImportRequest(value: unknown): CataloguePrepareImportRequest {
  const request = assertRecord(value, "Catalogue import preparation request");
  assertKeys(request, ["ownerRepo", "skill"], "Catalogue import preparation request");
  return { ownerRepo: readOwnerRepo(request.ownerRepo), skill: readId(request.skill, "Catalogue skill id") };
}

function readRelativePath(value: unknown): string {
  const path = readText(value, "Catalogue import relative path").replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || hasControlCharacter(path))
    throw new Error("Catalogue import relative path is unsafe.");
  return path;
}

function readOpaque(value: unknown, label: string): string {
  const text = readText(value, label);
  if (text.includes("/") || text.includes("\\") || text.includes("..") || hasControlCharacter(text))
    throw new Error(`${label} must be opaque.`);
  return text;
}

export function parseCataloguePrepareImportResponse(value: unknown): CataloguePrepareImportResponse {
  const response = assertRecord(value, "Catalogue import preparation response");
  if (response.status === "offline") {
    assertKeys(response, ["status"], "Catalogue import preparation response");
    return { status: "offline" };
  }
  if (response.status === "unavailable") {
    assertKeys(response, ["status", "reason"], "Catalogue import preparation response");
    return { status: "unavailable", reason: readOptionalText(response.reason, "Catalogue import reason", 240) ?? "" };
  }
  if (response.status === "ready") {
    assertKeys(
      response,
      ["status", "sourceId", "grantHandle", "relativePath"],
      "Catalogue import preparation response",
    );
    return {
      status: "ready",
      sourceId: readId(response.sourceId, "Catalogue import source id"),
      grantHandle: readOpaque(response.grantHandle, "Catalogue import grant handle"),
      relativePath: readRelativePath(response.relativePath),
    };
  }
  throw new Error("Catalogue import preparation response status is invalid.");
}
