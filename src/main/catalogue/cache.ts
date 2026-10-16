import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CatalogueSkillMdState } from "../../shared/catalogue-ipc";
import type { CatalogueSnapshotEntry } from "./index";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_SKILL_MD_BYTES = 512 * 1024;

export function catalogueCacheRoot(userDataPath: string): string {
  return join(userDataPath, "omni", "catalogue-cache");
}

export type CatalogueProvenanceMarker = Readonly<{ ownerRepo: string; skill: string; url: string; hash: string }>;

/**
 * Reads the `.omni-catalogue-provenance.json` sidecar `prepareCatalogueImportFiles` writes next
 * to a prepared import root. `src/main/operations-import.ts` calls this (read-only, "provenance
 * passthrough only") so a package imported from the Catalogue tab names its real origin in the
 * marketplace's package manifest instead of the cache folder's basename. Any other import leaves
 * no such file, and a malformed one is simply ignored — never a second import path.
 */
export function parseCatalogueProvenanceMarker(raw: string): CatalogueProvenanceMarker | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.source === "skills.sh" &&
      typeof parsed.ownerRepo === "string" &&
      typeof parsed.skill === "string" &&
      typeof parsed.url === "string" &&
      typeof parsed.hash === "string"
    ) {
      return { ownerRepo: parsed.ownerRepo, skill: parsed.skill, url: parsed.url, hash: parsed.hash };
    }
  } catch {
    // Not a catalogue import; the marker file is simply absent, unreadable, or unrelated.
  }
  return undefined;
}

function cacheSlug(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

/** A stable, IPC-safe id for the ephemeral registry-grant subject issued for one catalogue skill. */
export function catalogueGrantSourceId(ownerRepo: string, skill: string): string {
  return `catalogue-${createHash("sha256").update(`${ownerRepo}/${skill}`, "utf8").digest("hex").slice(0, 32)}`;
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readCachedContent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

type FetchText = (url: string, timeoutMs: number) => Promise<Readonly<{ ok: boolean; text?: string }>>;

async function defaultFetchText(url: string, timeoutMs: number): Promise<Readonly<{ ok: boolean; text?: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) return { ok: false };
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SKILL_MD_BYTES) return { ok: false };
    return { ok: true, text };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export type CatalogueSkillMdOptions = Readonly<{ fetchText?: FetchText }>;

/**
 * The catalogue's only run-time network call (Brief 34b §2): fetches a resolved skill's
 * `SKILL.md` from `raw.githubusercontent.com` when the entry page opens it, 15 s timeout, cached
 * on disk by the content's own sha256 so a second view of the same content never refetches.
 * A snapshot entry with no resolved `path` never reaches the network at all. A network failure
 * returns the honest `{ status: "offline" }` — it never serves stale cached content silently.
 */
export async function fetchCatalogueSkillMd(
  entry: Pick<CatalogueSnapshotEntry, "path" | "url" | "hash">,
  userDataPath: string,
  options: CatalogueSkillMdOptions = {},
): Promise<CatalogueSkillMdState> {
  if (!entry.path || !entry.url) return { status: "unavailable", reason: "No SKILL.md was found for this skill." };
  const fetchText = options.fetchText ?? defaultFetchText;
  const cacheRoot = catalogueCacheRoot(userDataPath);

  if (entry.hash) {
    const cached = await readCachedContent(join(cacheRoot, `${entry.hash}.md`));
    if (cached !== undefined) return { status: "ready", content: cached };
  }

  const result = await fetchText(entry.url, FETCH_TIMEOUT_MS);
  if (!result.ok || result.text === undefined) return { status: "offline" };
  const hash = createHash("sha256").update(result.text, "utf8").digest("hex");
  await writeFileAtomically(join(cacheRoot, `${hash}.md`), result.text).catch(() => undefined);
  return { status: "ready", content: result.text };
}

export type PreparedCatalogueImport = Readonly<{ root: string; relativePath: string; skillMd: string }>;

/**
 * Writes the already-fetched `SKILL.md` into the layout the existing import operation expects
 * (`skills/<skill>/SKILL.md` under a per-repository root — see `src/main/operations-import-plan.ts`'s
 * `inspectUnit`, which finds the skill id by locating a `skills/` path segment) so "Add to my
 * marketplace…" reuses that operation unchanged, plus a small sidecar recording where the file
 * came from (`src/main/operations-import.ts` reads it, "provenance passthrough only").
 */
export async function prepareCatalogueImportFiles(
  entry: Pick<CatalogueSnapshotEntry, "ownerRepo" | "skill" | "url" | "hash">,
  skillMd: string,
  userDataPath: string,
): Promise<PreparedCatalogueImport> {
  const root = join(catalogueCacheRoot(userDataPath), "import", cacheSlug(entry.ownerRepo));
  const relativePath = `skills/${cacheSlug(entry.skill)}/SKILL.md`;
  await writeFileAtomically(join(root, relativePath), skillMd);
  await writeFileAtomically(
    join(root, ".omni-catalogue-provenance.json"),
    JSON.stringify(
      {
        source: "skills.sh",
        ownerRepo: entry.ownerRepo,
        skill: entry.skill,
        url: entry.url,
        hash: entry.hash,
      },
      null,
      2,
    ),
  );
  return { root, relativePath, skillMd };
}

/** The grant-issuable identity of a prepared import root: its canonical path, device, and inode. */
export async function catalogueImportRootIdentity(
  root: string,
): Promise<Readonly<{ canonicalPath: string; device: string; inode: string }>> {
  const canonicalPath = await realpath(root);
  const details = await stat(canonicalPath);
  return { canonicalPath, device: String(details.dev), inode: String(details.ino) };
}
