import { performance } from "node:perf_hooks";
import { publicationCommitSchema, publicationPathSchema } from "../../domain/publications";
import type { ExternalUse } from "../../shared/external-library-ipc";
import {
  readGitTextOrThrow,
  withGitObjectReader,
  readGitObjectTree,
  prefetchGitTreeBlobs,
  GitHistoryTimeout,
  type GitObject,
  type GitObjectReader,
} from "../git-read";
import { fingerprintExternalFiles } from "./trees";
export type ExternalBaseOptions = Readonly<{ timeoutMs?: number; sinceCommit?: string }>;
export type ExternalRecoveredBase = Readonly<{ base: ExternalUse["base"]; files?: Record<string, Uint8Array> }>;
function isTimeout(error: unknown): boolean {
  return (
    error instanceof GitHistoryTimeout ||
    Boolean(error && typeof error === "object" && "killed" in error && error.killed)
  );
}
export async function recoverExternalBase(
  root: string,
  path: string,
  hash: string,
  maximum = 300,
  options: ExternalBaseOptions = {},
): Promise<ExternalRecoveredBase> {
  const deadline = performance.now() + (options.timeoutMs ?? 30000);
  const remaining = (): number => {
    const milliseconds = Math.ceil(deadline - performance.now());
    if (milliseconds <= 0) throw new GitHistoryTimeout();
    return milliseconds;
  };
  let scanned = 0;
  try {
    publicationPathSchema.parse(path);
    const revisions = await recoveryRevisions(root, options.sinceCommit, remaining);
    const log = await readGitTextOrThrow(
      root,
      ["log", `-${maximum + 1}`, "--format=%H", ...revisions, "--", path],
      remaining(),
    );
    if (!log) return { base: { status: "not-found", scanned, bounded: false } };
    const commits = log.split(/\r?\n/u);
    return await withGitObjectReader(
      root,
      async (reader) => {
        const history = await prepareRecoveryHistory(root, path, commits.slice(0, maximum), reader, remaining);
        const checked = new Set<string>();
        for (const { commit, object } of history) {
          remaining();
          scanned++;
          if (!object || checked.has(object.oid)) continue;
          checked.add(object.oid);
          const tree = await readGitObjectTree(reader, object);
          const files = readRecoveryFiles(tree);
          if (fingerprintExternalFiles(files) === hash)
            return { base: { status: "found" as const, commit, scanned }, files };
        }
        return { base: { status: "not-found" as const, scanned, bounded: commits.length > maximum } };
      },
      remaining(),
    );
  } catch (error) {
    if (isTimeout(error)) return { base: { status: "not-found", scanned, bounded: true, reason: "timeout" } };
    return {
      base: {
        status: "unknown",
        reason: "The source history contains unavailable or unsafe files. Check the source again.",
      },
    };
  }
}

type HistoryEntry = Readonly<{ commit: string; object?: GitObject }>;
async function prepareRecoveryHistory(
  root: string,
  path: string,
  commits: readonly string[],
  reader: GitObjectReader,
  remaining: () => number,
): Promise<HistoryEntry[]> {
  const history: HistoryEntry[] = [];
  const unique = new Map<string, GitObject>();
  for (const commit of commits) {
    remaining();
    publicationCommitSchema.parse(commit);
    const read = await reader.read(`${commit}:${path}`);
    const object = read ? (unique.get(read.oid) ?? read) : undefined;
    if (object) unique.set(object.oid, object);
    history.push({ commit, object });
  }
  try {
    await prefetchGitTreeBlobs(root, [...unique.values()], remaining(), reader);
  } catch (error) {
    if (isTimeout(error)) throw error;
    // Servers may reject bulk object wants; the batch reader can still fetch blobs lazily.
    remaining();
  }
  return history;
}
async function recoveryRevisions(root: string, since: string | undefined, remaining: () => number): Promise<string[]> {
  if (!since) return [];
  publicationCommitSchema.parse(since);
  try {
    await readGitTextOrThrow(root, ["merge-base", "--is-ancestor", since, "HEAD"], remaining());
    return ["HEAD", `^${since}`];
  } catch (error) {
    if (isTimeout(error)) throw error;
    return [];
  }
}
function readRecoveryFiles(tree: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const files = Object.fromEntries(
    Object.entries(tree).filter(
      ([path]) => !path.split("/").some((part) => part === ".git" || part === "node_modules"),
    ),
  );
  const bytes = Object.values(files);
  if (
    bytes.length > 512 ||
    bytes.some((file) => file.byteLength > 1024 * 1024) ||
    bytes.reduce((total, file) => total + file.byteLength, 0) > 16 * 1024 * 1024
  )
    throw new Error("The source history exceeds the skill reading limits.");
  return files;
}
