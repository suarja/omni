import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SkillDirectoryEnvelope } from "./unbound-reader";

type PayloadFile = Readonly<{ path: string; hash: string; byteLength: number; storedAs: string }>;
type PayloadIndex = Readonly<{
  version: 1;
  intentId: string;
  sourceFiles: readonly PayloadFile[];
  beforeFiles: readonly PayloadFile[];
  sourceEnvelope: SkillDirectoryEnvelope;
  beforeEnvelope: SkillDirectoryEnvelope;
}>;

export type PreparedUnboundPayload = Readonly<{
  root: string;
  index: PayloadIndex;
  sourceFiles: ReadonlyMap<string, Uint8Array>;
  beforeFiles: ReadonlyMap<string, Uint8Array>;
}>;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(path: string): boolean {
  return (
    Boolean(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

function validIntent(intentId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(intentId);
}

function payloadRoot(userDataPath: string, intentId: string): string {
  if (!validIntent(intentId)) throw new Error("Unbound resolution intent id is invalid.");
  return join(userDataPath, "omni", "skill-unbound-resolutions", intentId);
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory())
    throw new Error("Unbound resolution recovery storage must be a regular directory.");
  await chmod(path, 0o700);
}

async function writeExclusiveOrVerify(path: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
  } catch (error: unknown) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile())
      throw new Error("Unbound resolution recovery payload must be a regular immutable file.");
    const previous = Uint8Array.from(await readFile(path));
    if (previous.byteLength !== bytes.byteLength || hash(previous) !== hash(bytes))
      throw new Error("Unbound resolution recovery payload already contains different bytes.");
  } finally {
    await handle?.close();
  }
}

function entries(files: ReadonlyMap<string, Uint8Array>, prefix: string): readonly PayloadFile[] {
  if (files.size > 512) throw new Error("Unbound resolution payload exceeds the file count limit.");
  let bytesTotal = 0;
  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes], index) => {
      if (!safeRelative(path) || bytes.byteLength > 1024 * 1024)
        throw new Error("Unbound resolution payload file is unsafe or too large.");
      bytesTotal += bytes.byteLength;
      if (bytesTotal > 16 * 1024 * 1024) throw new Error("Unbound resolution payload exceeds the folder size limit.");
      return {
        path,
        hash: hash(bytes),
        byteLength: bytes.byteLength,
        storedAs: `${prefix}-${index.toString().padStart(4, "0")}.bin`,
      };
    });
}

export async function prepareUnboundPayload(
  args: Readonly<{
    userDataPath: string;
    intentId: string;
    sourceFiles: ReadonlyMap<string, Uint8Array>;
    beforeFiles: ReadonlyMap<string, Uint8Array>;
    sourceEnvelope: SkillDirectoryEnvelope;
    beforeEnvelope: SkillDirectoryEnvelope;
  }>,
): Promise<PreparedUnboundPayload> {
  const root = payloadRoot(args.userDataPath, args.intentId);
  const sourceEntries = entries(args.sourceFiles, "source");
  const beforeEntries = entries(args.beforeFiles, "before");
  const dirs = [
    join(args.userDataPath, "omni"),
    join(args.userDataPath, "omni", "skill-unbound-resolutions"),
    root,
    join(root, "source"),
    join(root, "before"),
  ];
  for (const directory of dirs) await ensureDirectory(directory);
  for (const [kind, values, files] of [
    ["source", args.sourceFiles, sourceEntries],
    ["before", args.beforeFiles, beforeEntries],
  ] as const) {
    for (const entry of files) await writeExclusiveOrVerify(join(root, kind, entry.storedAs), values.get(entry.path)!);
  }
  const index: PayloadIndex = {
    version: 1,
    intentId: args.intentId,
    sourceFiles: sourceEntries,
    beforeFiles: beforeEntries,
    sourceEnvelope: args.sourceEnvelope,
    beforeEnvelope: args.beforeEnvelope,
  };
  await writeExclusiveOrVerify(join(root, "index.json"), Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8"));
  const saved = await readPreparedUnboundPayload(args.userDataPath, args.intentId);
  if (!saved) throw new Error("Prepared unbound resolution payload failed verification.");
  return saved;
}

function parseEnvelope(value: unknown): SkillDirectoryEnvelope {
  if (!Array.isArray(value) || value.length > 2048) throw new Error("Unbound resolution envelope is invalid.");
  const items = value.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("Unbound resolution envelope item is invalid.");
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).some((key) => !["path", "kind", "identity"].includes(key)) ||
      typeof item.path !== "string" ||
      (item.path !== "." && !safeRelative(item.path)) ||
      (item.kind !== "file" && item.kind !== "directory") ||
      typeof item.identity !== "string" ||
      !item.identity
    ) {
      throw new Error("Unbound resolution envelope item is invalid.");
    }
    return { path: item.path, kind: item.kind, identity: item.identity } as const;
  });
  if (new Set(items.map((item) => item.path)).size !== items.length)
    throw new Error("Unbound resolution envelope paths are duplicated.");
  return items.sort((left, right) => left.path.localeCompare(right.path));
}

function parseIndex(value: unknown, intentId: string): PayloadIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Unbound resolution payload index is invalid.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["version", "intentId", "sourceFiles", "beforeFiles", "sourceEnvelope", "beforeEnvelope"].includes(key),
    ) ||
    input.version !== 1 ||
    input.intentId !== intentId ||
    !Array.isArray(input.sourceFiles) ||
    !Array.isArray(input.beforeFiles)
  ) {
    throw new Error("Unbound resolution payload index is invalid.");
  }
  const parseFiles = (value: unknown): readonly PayloadFile[] => {
    if (!Array.isArray(value) || value.length > 512) throw new Error("Unbound resolution payload files are invalid.");
    const result = value.map((raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new Error("Unbound resolution payload file is invalid.");
      const file = raw as Record<string, unknown>;
      if (
        Object.keys(file).some((key) => !["path", "hash", "byteLength", "storedAs"].includes(key)) ||
        typeof file.path !== "string" ||
        !safeRelative(file.path) ||
        typeof file.hash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(file.hash) ||
        typeof file.byteLength !== "number" ||
        !Number.isSafeInteger(file.byteLength) ||
        file.byteLength < 0 ||
        file.byteLength > 1024 * 1024 ||
        typeof file.storedAs !== "string" ||
        !/^(source|before)-\d{4}\.bin$/u.test(file.storedAs)
      ) {
        throw new Error("Unbound resolution payload file is invalid.");
      }
      return { path: file.path, hash: file.hash, byteLength: file.byteLength, storedAs: file.storedAs };
    });
    if (
      new Set(result.map((file) => file.path)).size !== result.length ||
      result.reduce((total, file) => total + file.byteLength, 0) > 16 * 1024 * 1024
    )
      throw new Error("Unbound resolution payload files are duplicated or too large.");
    return result;
  };
  return {
    version: 1,
    intentId,
    sourceFiles: parseFiles(input.sourceFiles),
    beforeFiles: parseFiles(input.beforeFiles),
    sourceEnvelope: parseEnvelope(input.sourceEnvelope),
    beforeEnvelope: parseEnvelope(input.beforeEnvelope),
  };
}

async function readPayloadFiles(
  root: string,
  folder: "source" | "before",
  files: readonly PayloadFile[],
): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
  const result = new Map<string, Uint8Array>();
  for (const entry of files) {
    if (entry.storedAs.startsWith(`${folder}-`) === false) return undefined;
    const path = join(root, folder, entry.storedAs);
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile() || details.size !== entry.byteLength) return undefined;
    const bytes = Uint8Array.from(await readFile(path));
    if (hash(bytes) !== entry.hash) return undefined;
    result.set(entry.path, bytes);
  }
  return result;
}

export async function readPreparedUnboundPayload(
  userDataPath: string,
  intentId: string,
): Promise<PreparedUnboundPayload | undefined> {
  const root = payloadRoot(userDataPath, intentId);
  try {
    for (const path of [join(userDataPath, "omni"), dirname(root), root, join(root, "source"), join(root, "before")]) {
      const details = await lstat(path);
      if (details.isSymbolicLink() || !details.isDirectory()) return undefined;
    }
    const indexPath = join(root, "index.json");
    const indexStat = await lstat(indexPath);
    if (indexStat.isSymbolicLink() || !indexStat.isFile() || indexStat.size > 1024 * 1024) return undefined;
    const index = parseIndex(JSON.parse(await readFile(indexPath, "utf8")) as unknown, intentId);
    const sourceFiles = await readPayloadFiles(root, "source", index.sourceFiles);
    const beforeFiles = await readPayloadFiles(root, "before", index.beforeFiles);
    if (!sourceFiles || !beforeFiles) return undefined;
    return { root, index, sourceFiles, beforeFiles };
  } catch {
    return undefined;
  }
}
