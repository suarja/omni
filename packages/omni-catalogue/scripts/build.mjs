#!/usr/bin/env node
// Builds packages/omni-catalogue/catalogue.json from the public skills.sh leaderboard and
// GitHub (Brief 34b). Plain Node >= 23 (see README's "Building the snapshot" — Node's native
// TypeScript type stripping, unflagged since 23.6, is what lets this script import
// `src/domain/stack-tags.ts` and `src/adapters/inventory/frontmatter.ts` directly instead of
// keeping copies), no dependencies beyond Node's own `fetch`/`crypto`/`fs`.
// Network: skills.sh (leaderboard page + one page per skill), raw.githubusercontent.com, and
// api.github.com (the repo-tree fallback below). GITHUB_TOKEN, if set, is sent to both GitHub
// hosts to raise their anonymous rate limits — it is never required and never sent to skills.sh.
// Reading `process.env.GITHUB_TOKEN` is the only environment access in this script.
//
// Idempotent and resumable: every fetched page, repo tree, and resolved SKILL.md path is cached
// under `.cache/` (git-ignored); a re-run reuses what is already there and only fetches what is
// missing, so an interrupted run — or one cut short by GitHub's unauthenticated rate limit — can
// simply be started again.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const CACHE_ROOT = join(PACKAGE_ROOT, ".cache");
const CATALOGUE_PATH = join(PACKAGE_ROOT, "catalogue.json");

// The one table of record for keyword tagging and the one frontmatter parser, imported directly
// rather than kept as copies — Node strips their type annotations at load time (see the file
// header comment above).
const { tagsForText } = await import(pathToFileURL(join(REPO_ROOT, "src", "domain", "stack-tags.ts")).href);
const { parseFrontmatter } = await import(
  pathToFileURL(join(REPO_ROOT, "src", "adapters", "inventory", "frontmatter.ts")).href
);

const HOME_URL = "https://skills.sh/";
const MIN_ENTRIES = 200;
const MAX_CANDIDATE_PATHS = 6;
const MAX_CONCURRENCY = 4;
const RAW_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_SKILL_MD_BYTES = 512 * 1024;
const GITHUB_TOKEN = typeof process.env.GITHUB_TOKEN === "string" ? process.env.GITHUB_TOKEN.trim() : "";

function log(message) {
  process.stdout.write(`${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

/** Bounds total in-flight HTTP requests across the whole run to `MAX_CONCURRENCY`. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
}

const limiter = createLimiter(MAX_CONCURRENCY);

/**
 * A timed, retried fetch (429/5xx and network errors back off with jitter, `MAX_RETRIES`
 * attempts). Never throws for an HTTP-level failure — callers get `{ ok: false, status }`.
 */
async function fetchSafely(url, { method = "GET", headers = {} } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RAW_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method, headers, signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_RETRIES) return { ok: false, status: response.status };
        await sleep(backoffMs(attempt));
        continue;
      }
      if (!response.ok) return { ok: false, status: response.status };
      const text = method === "HEAD" ? "" : await response.text();
      return { ok: true, status: response.status, text };
    } catch {
      clearTimeout(timer);
      if (attempt >= MAX_RETRIES) return { ok: false, status: 0 };
      await sleep(backoffMs(attempt));
    }
  }
}

function fetchLimited(url, options) {
  return limiter(() => fetchSafely(url, options));
}

async function readCache(relativePath) {
  try {
    return await readFile(join(CACHE_ROOT, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

async function writeCache(relativePath, content) {
  const target = join(CACHE_ROOT, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function cacheSlug(value) {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

/** GET with an on-disk cache: a resumed run never re-fetches a page it already has. */
async function fetchCachedText(url, cacheRelativePath, options) {
  const cached = await readCache(cacheRelativePath);
  if (cached !== undefined) return { ok: true, text: cached, fromCache: true };
  const result = await fetchLimited(url, options);
  if (!result.ok) return { ok: false, status: result.status, fromCache: false };
  await writeCache(cacheRelativePath, result.text);
  return { ok: true, text: result.text, fromCache: false };
}

// --- Extraction: home page leaderboard --------------------------------------------------------

/**
 * Balanced-bracket scan from the first `[` after `startIndex`: tolerant of the surrounding markup
 * (the array sits inside a JSON-escaped React Server Components string), fragile only to the
 * array's own contents changing shape, which is exactly what should fail the build loudly.
 */
function extractBalancedArray(html, startIndex) {
  const open = html.indexOf("[", startIndex);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === "[") depth += 1;
    else if (html[i] === "]") {
      depth -= 1;
      if (depth === 0) return html.slice(open, i + 1);
    }
  }
  return undefined;
}

function unescapeJsonString(text) {
  return text.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

/**
 * Extracts every `initialSkills` array embedded in the home page's RSC payload (there is
 * normally exactly one, ~600 entries across the all-time and trending views per
 * the catalogue contract), deduplicated by `source + skillId`. Throws
 * (fails the build loudly) if the result has fewer than `MIN_ENTRIES` entries: the page layout
 * changed and the extractor needs updating, not a silent empty catalogue.
 */
export function extractInitialSkills(html, minEntries = MIN_ENTRIES) {
  const seen = new Map();
  let searchFrom = 0;
  for (;;) {
    const marker = html.indexOf("initialSkills", searchFrom);
    if (marker < 0) break;
    const afterMarker = marker + "initialSkills".length;
    const colon = html.indexOf(":", afterMarker);
    searchFrom = afterMarker;
    // Between the key and its colon there is at most a closing quote, JSON-escaped as `\"` in
    // the RSC payload (`initialSkills\":`) or plain in a `<script>` tag (`initialSkills":`) —
    // never anything else, so a wider gap means this was an unrelated match.
    if (colon < 0 || !/^[\\"\s]{0,4}$/.test(html.slice(afterMarker, colon))) continue;
    const arrayText = extractBalancedArray(html, colon);
    if (!arrayText) continue;
    let parsed;
    try {
      parsed = JSON.parse(unescapeJsonString(arrayText));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const source = typeof item.source === "string" ? item.source : undefined;
      const skillId = typeof item.skillId === "string" ? item.skillId : undefined;
      const name = typeof item.name === "string" ? item.name : skillId;
      if (!source || !skillId || !name) continue;
      const key = `${source}#${skillId}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        ownerRepo: source,
        skill: skillId,
        name,
        installs: typeof item.installs === "number" ? item.installs : 0,
        weeklyInstalls: Array.isArray(item.weeklyInstalls)
          ? item.weeklyInstalls.filter((n) => typeof n === "number")
          : [],
        official: item.isOfficial === true,
      });
    }
  }
  const entries = [...seen.values()];
  if (entries.length < minEntries)
    throw new Error(
      `skills.sh home page layout changed: found only ${entries.length} leaderboard entries (expected at least ${minEntries}).`,
    );
  return entries;
}

// --- Extraction: a skill's own page ------------------------------------------------------------

/**
 * The first *unescaped* `SoftwareApplication` JSON-LD block (`<script type="application/ld+json">`
 * renders it plainly; the RSC payload further down the page carries a backslash-escaped copy,
 * which the `(?<!\\)` guards skip). Tolerant of surrounding markup by design: it only needs the
 * `{ … }` object to be well-formed JSON, not a particular script tag shape.
 */
export function extractSoftwareApplicationJsonLd(html) {
  const match = /(?<!\\)"@type"\s*:\s*(?<!\\)"SoftwareApplication"/.exec(html);
  if (!match) return undefined;
  const open = html.lastIndexOf("{", match.index);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(open, i + 1));
          return {
            name: typeof parsed.name === "string" ? parsed.name : undefined,
            description: typeof parsed.description === "string" ? parsed.description : undefined,
          };
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** `npx skills add <owner>/<repo> --skill <name>` or `... https://github.com/<owner>/<repo> ...`. */
export function extractInstallCommand(html) {
  const match = /skills add ([^\s"<]+) --skill ([^\s"<]+)/.exec(html);
  if (!match) return undefined;
  const target = match[1].replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  return { ownerRepo: target, skill: match[2] };
}

// --- SKILL.md path resolution and frontmatter ---------------------------------------------------

export function candidatePaths(skill) {
  return [
    "SKILL.md",
    `skills/${skill}/SKILL.md`,
    `.claude/skills/${skill}/SKILL.md`,
    `.agents/skills/${skill}/SKILL.md`,
    `.codex/skills/${skill}/SKILL.md`,
    `.cursor/skills/${skill}/SKILL.md`,
  ].slice(0, MAX_CANDIDATE_PATHS);
}

export function rawUrl(ownerRepo, path) {
  return `https://raw.githubusercontent.com/${ownerRepo}/HEAD/${path}`;
}

function githubHeaders() {
  return GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {};
}

/**
 * Tries each convention path in order, stopping at the first `HEAD` that succeeds. `fetcher`
 * defaults to the real rate-limited network fetch; tests inject a fake so the resolver's own
 * logic (order, early stop, "none resolved") is verified without a single HTTP request.
 */
export async function resolveSkillMdPath(ownerRepo, skill, fetcher = fetchLimited) {
  for (const path of candidatePaths(skill)) {
    const result = await fetcher(rawUrl(ownerRepo, path), { method: "HEAD", headers: githubHeaders() });
    if (result.ok) return path;
  }
  return undefined;
}

// --- SKILL.md path resolution, stage 2: whole-repo tree scan ------------------------------------
//
// Stage 1's six convention paths miss a categorised layout (`skills/<category>/<name>/SKILL.md`,
// e.g. `mattpocock/skills` → `skills/engineering/grill-me/SKILL.md`). Stage 2 fetches each
// repo's full file tree once — via the Git Trees API, not another guess-and-check probe — and
// matches on it locally.

function githubApiHeaders() {
  const headers = { Accept: "application/vnd.github+json" };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

/** Fetches (and caches) one repo's recursive Git tree. Never throws: rate limits are reported, not fatal. */
async function fetchRepoTree(ownerRepo) {
  const url = `https://api.github.com/repos/${ownerRepo}/git/trees/HEAD?recursive=1`;
  const cacheKey = `trees/${cacheSlug(ownerRepo)}.json`;
  const result = await fetchCachedText(url, cacheKey, { headers: githubApiHeaders() });
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.text);
    return { ok: true, tree: Array.isArray(parsed.tree) ? parsed.tree : [] };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Pure matcher (no network, no cache) over one repo's tree entries: every `SKILL.md` blob whose
 * immediate parent folder is named `skill`, plus a root `SKILL.md` when `skill` is the repo's own
 * name, shallowest path wins. Exported and unit-tested directly against a fake tree listing.
 */
export function findSkillMdInTree(tree, skill, repoName) {
  const matches = [];
  for (const entry of tree) {
    if (!entry || entry.type !== "blob" || typeof entry.path !== "string") continue;
    const segments = entry.path.split("/");
    if (segments[segments.length - 1] !== "SKILL.md") continue;
    const parent = segments.length >= 2 ? segments[segments.length - 2] : undefined;
    if (parent === skill || (segments.length === 1 && skill === repoName)) {
      matches.push({ path: entry.path, depth: segments.length });
    }
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => a.depth - b.depth);
  return matches[0].path;
}

// Dedupes repo-tree fetches to once per repo per run (the disk cache in `fetchRepoTree` already
// makes this once per repo across runs); tracks which repos hit a rate limit so `main` can report
// "N repos skipped by rate limit, rerun later" instead of failing the build.
const repoTreePromises = new Map();
const rateLimitedRepos = new Set();

async function getRepoTree(ownerRepo) {
  if (!repoTreePromises.has(ownerRepo)) repoTreePromises.set(ownerRepo, fetchRepoTree(ownerRepo));
  const result = await repoTreePromises.get(ownerRepo);
  if (!result.ok && (result.status === 403 || result.status === 429)) rateLimitedRepos.add(ownerRepo);
  return result;
}

/**
 * Stage 1 (six convention paths), then stage 2 (repo tree scan) when stage 1 misses. Returns the
 * resolved path (or `undefined`) and whether the miss was a rate limit, so the caller can skip
 * writing a permanent `path: null` to the resolution cache for what is only a transient failure.
 */
async function resolveSkillMdPathWithTreeFallback(ownerRepo, skill) {
  const stage1 = await resolveSkillMdPath(ownerRepo, skill);
  if (stage1) return { path: stage1, rateLimited: false };

  const treeResult = await getRepoTree(ownerRepo);
  if (!treeResult.ok) return { path: undefined, rateLimited: treeResult.status === 403 || treeResult.status === 429 };

  const repoName = ownerRepo.split("/")[1] ?? "";
  const byFolder = findSkillMdInTree(treeResult.tree, skill, repoName);
  if (byFolder) return { path: byFolder, rateLimited: false };
  return { path: await findSkillMdByFrontmatterName(ownerRepo, treeResult.tree, skill), rateLimited: false };
}

const MAX_TREE_SKILL_FILES = 40;

/**
 * Stage 3: the skills.sh id is the SKILL.md frontmatter `name`, which may differ from the folder
 * name (`vercel-react-best-practices` lives in `skills/react-best-practices/`). Reads every
 * SKILL.md of the tree (bounded, cached) and matches on the frontmatter name.
 */
async function findSkillMdByFrontmatterName(ownerRepo, tree, skill) {
  const candidates = tree
    .filter(
      (entry) => entry && entry.type === "blob" && typeof entry.path === "string" && entry.path.endsWith("SKILL.md"),
    )
    .slice(0, MAX_TREE_SKILL_FILES);
  for (const entry of candidates) {
    const cacheKey = `skillmd-tree/${cacheSlug(ownerRepo)}__${cacheSlug(entry.path)}.md`;
    const file = await fetchCachedText(rawUrl(ownerRepo, entry.path), cacheKey);
    if (!file.ok || Buffer.byteLength(file.text, "utf8") > MAX_SKILL_MD_BYTES) continue;
    const frontmatter = parseFrontmatter(file.text, false);
    if (frontmatter.name === skill) return entry.path;
  }
  return undefined;
}

// --- One skill entry ------------------------------------------------------------------------

async function buildEntry(leaderboardEntry, now) {
  const { ownerRepo, skill, name, installs, weeklyInstalls, official } = leaderboardEntry;
  const pageUrl = `https://skills.sh/${ownerRepo}/${skill}`;
  const pageCacheKey = `pages/${cacheSlug(ownerRepo)}__${cacheSlug(skill)}.html`;
  const page = await fetchCachedText(pageUrl, pageCacheKey);
  const jsonLd = page.ok ? extractSoftwareApplicationJsonLd(page.text) : undefined;
  const install = page.ok ? extractInstallCommand(page.text) : undefined;
  const resolvedOwnerRepo = install?.ownerRepo || ownerRepo;

  const resolutionCacheKey = `resolved/${cacheSlug(resolvedOwnerRepo)}__${cacheSlug(skill)}.json`;
  let resolution;
  const cachedResolution = await readCache(resolutionCacheKey);
  if (cachedResolution !== undefined) {
    resolution = JSON.parse(cachedResolution);
  } else {
    const { path, rateLimited } = await resolveSkillMdPathWithTreeFallback(resolvedOwnerRepo, skill);
    resolution = { path: path ?? null };
    // A rate-limited miss is transient — leave the resolution cache unwritten so a later rerun
    // (once GitHub's window resets) retries stage 2 instead of a permanent "not found".
    if (!rateLimited) await writeCache(resolutionCacheKey, JSON.stringify(resolution));
  }

  let description = jsonLd?.description;
  let hash;
  let fetchedAt;
  if (resolution.path) {
    const skillMdCacheKey = `skillmd/${cacheSlug(resolvedOwnerRepo)}__${cacheSlug(skill)}.md`;
    const skillMd = await fetchCachedText(rawUrl(resolvedOwnerRepo, resolution.path), skillMdCacheKey);
    if (skillMd.ok && Buffer.byteLength(skillMd.text, "utf8") <= MAX_SKILL_MD_BYTES) {
      const frontmatter = parseFrontmatter(skillMd.text, false);
      if (frontmatter.description) description = frontmatter.description;
      hash = createHash("sha256").update(skillMd.text, "utf8").digest("hex");
      fetchedAt = now;
    } else {
      resolution = { path: null };
    }
  }

  const tagText = `${name} ${description ?? ""}`;
  return {
    source: "skills.sh",
    ownerRepo: resolvedOwnerRepo,
    skill,
    name: jsonLd?.name || name,
    ...(description ? { description } : {}),
    path: resolution.path,
    ...(resolution.path ? { url: rawUrl(resolvedOwnerRepo, resolution.path) } : {}),
    tags: tagsForText(tagText),
    installs,
    weeklyInstalls,
    official,
    fetchedAt: fetchedAt ?? now,
    ...(hash ? { hash } : {}),
  };
}

// --- Main -----------------------------------------------------------------------------------

async function main() {
  await mkdir(CACHE_ROOT, { recursive: true });
  await mkdir(join(CACHE_ROOT, "pages"), { recursive: true });
  await mkdir(join(CACHE_ROOT, "skillmd"), { recursive: true });
  await mkdir(join(CACHE_ROOT, "resolved"), { recursive: true });
  await mkdir(join(CACHE_ROOT, "trees"), { recursive: true });

  const home = await fetchCachedText(HOME_URL, "home.html");
  if (!home.ok) throw new Error("Could not fetch the skills.sh home page.");
  const leaderboard = extractInitialSkills(home.text);
  log(`skills.sh leaderboard: ${leaderboard.length} entries.`);

  const now = new Date().toISOString();
  const entries = [];
  let index = 0;
  for (const leaderboardEntry of leaderboard) {
    index += 1;
    const entry = await buildEntry(leaderboardEntry, now);
    entries.push(entry);
    if (index % 25 === 0 || index === leaderboard.length)
      log(`  resolved ${index}/${leaderboard.length} (${entries.filter((e) => e.path).length} with a SKILL.md)`);
  }

  const catalogue = { builtAt: now, source: "skills.sh", entries };
  const json = JSON.stringify(catalogue, null, 2) + "\n";
  const byteSize = Buffer.byteLength(json, "utf8");
  if (byteSize > 2 * 1024 * 1024) throw new Error(`catalogue.json would be ${byteSize} bytes, over the 2 MiB budget.`);
  await writeFile(CATALOGUE_PATH, json, "utf8");

  const resolvedCount = entries.filter((entry) => entry.path).length;
  log(`Wrote ${CATALOGUE_PATH}`);
  log(`Entries: ${entries.length}`);
  log(`SKILL.md paths resolved: ${resolvedCount}/${entries.length}`);
  if (rateLimitedRepos.size > 0) log(`${rateLimitedRepos.size} repos skipped by rate limit, rerun later.`);
}

// Runs only when this file is executed directly (`node scripts/build.mjs`), never when a test
// imports it to exercise the pure extractors above with fixtures and a fake fetch.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
