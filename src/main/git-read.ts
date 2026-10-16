import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { publicationCommitSchema, publicationPathSchema } from "../domain/publications";
import { safeGitTransportArgs, gitTransportEnvironment } from "./git-transport";
import { runGitCommand } from "./git-command";

const exec = promisify(execFile);
async function readGit(
  root: string,
  args: readonly string[],
  timeout = 10000,
  input?: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<Buffer> {
  const pending = exec("git", safeGitTransportArgs(["--no-optional-locks", ...args]), {
    cwd: root,
    encoding: "buffer",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...gitTransportEnvironment(), GIT_OPTIONAL_LOCKS: "0", ...environment },
  });
  pending.child.stdin?.end(input);
  return (await pending).stdout;
}
export async function readGitText(root: string, args: readonly string[]): Promise<string | undefined> {
  try {
    return await readGitTextOrThrow(root, args);
  } catch {
    return undefined;
  }
}
export async function readGitTextOrThrow(
  root: string,
  args: readonly string[],
  timeout = 10000,
): Promise<string | undefined> {
  return (await readGit(root, args, timeout)).toString("utf8").trim() || undefined;
}
export async function readBaseFiles(
  root: string,
  commit: string,
  folder: string,
): Promise<Record<string, Uint8Array> | undefined> {
  publicationCommitSchema.parse(commit);
  publicationPathSchema.parse(folder);
  return withGitObjectReader(root, async (reader) => {
    if (!(await reader.read(`${commit}^{commit}`))) return undefined;
    const object = await reader.read(`${commit}:${folder}`);
    return object ? readGitObjectTree(reader, object) : (Object.create(null) as Record<string, Uint8Array>);
  });
}

export async function readBaseHashes(
  root: string,
  commit: string,
  folder: string,
): Promise<Record<string, string> | undefined> {
  const files = await readBaseFiles(root, commit, folder);
  return (
    files &&
    Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => path !== "omni.plugin.json")
        .map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]),
    )
  );
}

export async function readCommittedFile(root: string, commit: string, path: string): Promise<Uint8Array | undefined> {
  publicationCommitSchema.parse(commit);
  publicationPathSchema.parse(path);
  try {
    return await readGit(root, ["show", `${commit}:${path}`]);
  } catch {
    return undefined;
  }
}

export type GitObject = Readonly<{ oid: string; type: string; bytes: Buffer }>;
export type GitObjectReader = Readonly<{ read(expression: string): Promise<GitObject | undefined> }>;
export class GitHistoryTimeout extends Error {
  constructor() {
    super("The Git history reading deadline expired.");
  }
}
export async function withGitObjectReader<T>(
  root: string,
  operation: (reader: GitObjectReader) => Promise<T>,
  timeoutMs = 30000,
): Promise<T> {
  if (timeoutMs <= 0) throw new GitHistoryTimeout();
  const child = spawn("git", safeGitTransportArgs(["--no-optional-locks", "cat-file", "--batch"]), {
    cwd: root,
    shell: false,
    windowsHide: true,
    env: { ...gitTransportEnvironment(), GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let timedOut = false,
    failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  child.stderr.resume();
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const reader = createGitObjectReader(child, () => {
    if (timedOut) throw new GitHistoryTimeout();
    if (failure) throw failure;
  });
  try {
    return await operation(reader);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill("SIGKILL");
    await closed;
  }
}
function createGitObjectReader(child: ChildProcessWithoutNullStreams, assertAvailable: () => void): GitObjectReader {
  const stream = child.stdout[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  const receive = async (): Promise<void> => {
    const next = await stream.next();
    assertAvailable();
    if (next.done) throw new Error("Git object reading ended before the complete object was received.");
    buffer = Buffer.concat([buffer, next.value as Buffer]);
  };
  const read = async (expression: string): Promise<GitObject | undefined> => {
    assertAvailable();
    if (/[\r\n\0]/u.test(expression)) throw new Error("The Git object expression is unsafe.");
    child.stdin.write(`${expression}\n`);
    while (!buffer.includes(10)) await receive();
    const end = buffer.indexOf(10),
      header = buffer.subarray(0, end).toString("utf8");
    buffer = buffer.subarray(end + 1);
    if (header.endsWith(" missing")) return undefined;
    const match = /^([0-9a-f]{40,64}) (blob|tree|commit|tag) ([0-9]+)$/u.exec(header);
    if (!match) throw new Error("Git returned an invalid object header.");
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size > 64 * 1024 * 1024)
      throw new Error("The Git object exceeds the reading limit.");
    while (buffer.length < size + 1) await receive();
    if (buffer[size] !== 10) throw new Error("Git returned an incomplete object.");
    const bytes = Buffer.from(buffer.subarray(0, size));
    buffer = buffer.subarray(size + 1);
    return { oid: match[1]!, type: match[2]!, bytes };
  };
  return { read };
}
export async function readGitObjectTree(
  reader: GitObjectReader,
  object: GitObject,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = Object.create(null);
  let entries = 0,
    totalBytes = 0;
  const visit = async (tree: GitObject, prefix: string): Promise<void> => {
    if (tree.type !== "tree") throw new Error("The Git skill folder is not a tree.");
    const oidBytes = tree.oid.length / 2;
    for (let offset = 0; offset < tree.bytes.length;) {
      const space = tree.bytes.indexOf(32, offset),
        nul = tree.bytes.indexOf(0, space);
      if (space < offset || nul < space || nul + 1 + oidBytes > tree.bytes.length)
        throw new Error("The Git tree contains an invalid entry.");
      const mode = tree.bytes.subarray(offset, space).toString(),
        name = new TextDecoder("utf8", { fatal: true }).decode(tree.bytes.subarray(space + 1, nul));
      const oid = tree.bytes.subarray(nul + 1, nul + 1 + oidBytes).toString("hex");
      offset = nul + 1 + oidBytes;
      const path = prefix ? `${prefix}/${name}` : name;
      publicationPathSchema.parse(path);
      if (++entries > 10000) throw new Error("The base plugin exceeds the publication entry limit.");
      if (!["40000", "100644", "100755"].includes(mode))
        throw new Error("The base plugin contains unsupported Git entries.");
      const child = await reader.read(oid);
      if (!child) throw new Error("The base plugin contains unavailable Git objects.");
      if (mode === "40000") await visit(child, path);
      else {
        if (child.type !== "blob") throw new Error("The base plugin contains an invalid file object.");
        totalBytes += child.bytes.length;
        if (totalBytes > 64 * 1024 * 1024) throw new Error("The base plugin exceeds the publication byte limit.");
        files[path] = child.bytes;
      }
    }
  };
  await visit(object, "");
  return files;
}
export async function prefetchGitTreeBlobs(
  root: string,
  trees: readonly (string | GitObject)[],
  timeoutMs: number,
  reader?: GitObjectReader,
): Promise<void> {
  if (!trees.length) return;
  const deadline = performance.now() + timeoutMs;
  const remaining = (): number => {
    const milliseconds = Math.ceil(deadline - performance.now());
    if (milliseconds <= 0) throw new GitHistoryTimeout();
    return milliseconds;
  };
  const blobs = reader
    ? await listTreeBlobs(reader, trees)
    : await withGitObjectReader(root, (reader) => listTreeBlobs(reader, trees), remaining());
  if (!blobs.length) return;
  const listing = await readGit(
    root,
    ["rev-list", "--objects", "--missing=print", "--no-object-names", "--stdin"],
    remaining(),
    `${blobs.join("\n")}\n`,
    { GIT_NO_LAZY_FETCH: "1" },
  );
  const missing = listing
    .toString()
    .split(/\r?\n/u)
    .filter((line) => /^\?[0-9a-f]{40,64}$/u.test(line))
    .map((line) => line.slice(1));
  if (missing.length)
    await runGitCommand(
      root,
      [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "origin",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
      ],
      remaining(),
      `${missing.join("\n")}\n`,
    );
}
async function listTreeBlobs(reader: GitObjectReader, trees: readonly (string | GitObject)[]): Promise<string[]> {
  const visited = new Set<string>(),
    blobs = new Set<string>();
  const visit = async (tree?: GitObject): Promise<void> => {
    if (!tree || tree.type !== "tree" || visited.has(tree.oid)) return;
    visited.add(tree.oid);
    const oidBytes = tree.oid.length / 2;
    for (let offset = 0; offset < tree.bytes.length;) {
      const space = tree.bytes.indexOf(32, offset),
        nul = tree.bytes.indexOf(0, space);
      if (space < offset || nul < space || nul + 1 + oidBytes > tree.bytes.length)
        throw new Error("The Git tree contains an invalid entry.");
      const mode = tree.bytes.subarray(offset, space).toString();
      const oid = tree.bytes.subarray(nul + 1, nul + 1 + oidBytes).toString("hex");
      offset = nul + 1 + oidBytes;
      if (mode === "40000") await visit(await reader.read(oid));
      else if (mode === "100644" || mode === "100755") blobs.add(oid);
    }
  };
  for (const tree of trees) await visit(typeof tree === "string" ? await reader.read(tree) : tree);
  return [...blobs];
}
