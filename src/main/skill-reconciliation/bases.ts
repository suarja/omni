import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createSkillRevision } from "../../domain/skill-reconciliation/revisions";
import { parseSkillRevision } from "../../domain/skill-reconciliation/validation";
import type { SkillRevision } from "../../domain/skill-reconciliation/types";
import type { SkillManagedBaseRead, SkillManagedBaseReader } from "../../ports/skill-reconciliation";

export type SkillBaseRead =
  | Readonly<{
      status: "ready";
      baseRevisionId: string;
      revision: SkillRevision;
      files: ReadonlyMap<string, Uint8Array>;
    }>
  | Exclude<SkillManagedBaseRead, Readonly<{ status: "ready" }>>;
export type SkillBasePublication = "created" | "existing";
export interface SkillBaseStore extends SkillManagedBaseReader {
  publish(
    baseRevisionId: string,
    revision: SkillRevision,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<SkillBasePublication>;
  read(baseRevisionId: string, maximumBytes?: number): Promise<SkillBaseRead>;
}

type Manifest = Readonly<{ version: 1; baseId: string; revision: SkillRevision }>;
type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function safeBaseId(value: string): string {
  if (!UUID.test(value)) throw new Error("Skill base id must be a UUID.");
  return value;
}

function safeRelativeFilePath(value: string): boolean {
  return (
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

function within(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileIdentity(details: FileIdentity): string {
  return [details.dev, details.ino, details.mode, details.size, details.mtimeNs, details.ctimeNs].join(":");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}

function parseManifest(value: unknown, expectedBaseId: string): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Skill base manifest is malformed.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["version", "baseId", "revision"].includes(key)))
    throw new Error("Skill base manifest has an unexpected field.");
  if (input.version !== 1 || input.baseId !== expectedBaseId)
    throw new Error("Skill base manifest identity is invalid.");
  return { version: 1, baseId: expectedBaseId, revision: parseSkillRevision(input.revision) };
}

async function assertDirectory(path: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory() || (await realpath(path)) !== path) {
    throw new Error("Skill base directory is unsafe.");
  }
}

async function ensureDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
  await assertDirectory(path);
}

async function readManifest(basePath: string, baseId: string): Promise<Manifest> {
  const path = join(basePath, "manifest.json");
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_MANIFEST_BYTES) {
    throw new Error("Skill base manifest is unsafe.");
  }
  return parseManifest(JSON.parse(await readFile(path, "utf8")) as unknown, baseId);
}

async function readStoredFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maximumBytes)) {
    throw new Error("Skill base file is unsafe or exceeds its manifest length.");
  }
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("Skill base file reads require no-follow support.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || fileIdentity(opened) !== fileIdentity(before))
      throw new Error("Skill base file changed during verification.");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (fileIdentity(after) !== fileIdentity(opened) || bytes.byteLength !== Number(after.size)) {
      throw new Error("Skill base file changed during verification.");
    }
    return Uint8Array.from(bytes);
  } finally {
    await handle.close();
  }
}

async function listStoredFiles(filesRoot: string): Promise<ReadonlyMap<string, Uint8Array>> {
  await assertDirectory(filesRoot);
  const files = new Map<string, Uint8Array>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const names = await readdir(directory);
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\"))
        throw new Error("Skill base contains an unsafe entry.");
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (!safeRelativeFilePath(relativePath)) throw new Error("Skill base contains an unsafe file path.");
      const details = await lstat(path);
      if (details.isSymbolicLink()) throw new Error("Skill base cannot contain symbolic links.");
      if (details.isDirectory()) {
        await visit(path, relativePath);
      } else if (details.isFile()) {
        files.set(relativePath, await readStoredFile(path, 1024 * 1024));
      } else {
        throw new Error("Skill base cannot contain special files.");
      }
    }
  };
  await visit(filesRoot, "");
  return files;
}

function sameSnapshot(
  left: Readonly<{ revision: SkillRevision; files: ReadonlyMap<string, Uint8Array> }>,
  right: Readonly<{ revision: SkillRevision; files: ReadonlyMap<string, Uint8Array> }>,
): boolean {
  if (JSON.stringify(left.revision) !== JSON.stringify(right.revision) || left.files.size !== right.files.size)
    return false;
  for (const [path, bytes] of left.files) {
    const other = right.files.get(path);
    if (!other || sha256(bytes) !== sha256(other) || bytes.byteLength !== other.byteLength) return false;
  }
  return true;
}

function validateSnapshot(revision: SkillRevision, files: ReadonlyMap<string, Uint8Array>): SkillRevision {
  const parsed = parseSkillRevision(revision);
  const paths = parsed.files.map(({ path }) => path);
  if (new Set(paths).size !== files.size || paths.some((path) => !files.has(path)))
    throw new Error("Skill base files do not match the complete revision manifest.");
  const entries = parsed.files.map(({ path, hash, byteLength }) => {
    const bytes = files.get(path)!;
    if (bytes.byteLength !== byteLength || sha256(bytes) !== hash)
      throw new Error("Skill base bytes do not match the complete revision manifest.");
    return { path, hash, byteLength };
  });
  const computed = createSkillRevision(entries, (manifest) => sha256(manifest));
  if (computed.hash !== parsed.hash) throw new Error("Skill base complete revision does not verify.");
  return computed;
}

async function verifyDirectorySnapshot(
  basePath: string,
  baseId: string,
  maximumBytes?: number,
): Promise<SkillBaseRead> {
  try {
    await assertDirectory(basePath);
    const allowed = await readdir(basePath);
    if (allowed.length !== 2 || !allowed.includes("manifest.json") || !allowed.includes("files")) {
      throw new Error("Skill base directory contents are invalid.");
    }
    const manifest = await readManifest(basePath, baseId);
    if (maximumBytes !== undefined) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
        throw new Error("Skill base read budget is invalid.");
      const declaredBytes = manifest.revision.files.reduce((total, file) => total + file.byteLength, 0);
      if (declaredBytes > maximumBytes) throw new Error("Skill base exceeds the requested read budget.");
    }
    const files = await listStoredFiles(join(basePath, "files"));
    const verifiedRevision = validateSnapshot(manifest.revision, files);
    return { status: "ready", baseRevisionId: baseId, revision: verifiedRevision, files };
  } catch (error: unknown) {
    return {
      status: "corrupt",
      reason: error instanceof Error ? error.message.slice(0, 220) : "Skill base could not be verified.",
    };
  }
}

export function createSkillBaseStore(userDataPath: string): SkillBaseStore {
  const requestedProfileRoot = resolve(userDataPath);
  let canonicalProfileRoot: Promise<string> | undefined;
  const getProfileRoot = (): Promise<string> => {
    canonicalProfileRoot ??= realpath(requestedProfileRoot).then(async (path) => {
      await assertDirectory(path);
      return path;
    });
    return canonicalProfileRoot;
  };
  const getBasesRoot = async (): Promise<string> => join(await getProfileRoot(), "omni", "skill-bases");

  const read = async (rawBaseId: string, maximumBytes?: number): Promise<SkillBaseRead> => {
    const baseId = safeBaseId(rawBaseId);
    try {
      const profileRoot = await getProfileRoot();
      const basesRoot = await getBasesRoot();
      await assertDirectory(join(profileRoot, "omni"));
      await assertDirectory(basesRoot);
      const basePath = join(basesRoot, baseId);
      if (!within(basesRoot, basePath))
        return { status: "corrupt", reason: "Skill base path is outside its profile store." };
      try {
        await lstat(basePath);
      } catch (error: unknown) {
        if (isCode(error, "ENOENT")) return { status: "missing" };
        throw error;
      }
      return verifyDirectorySnapshot(basePath, baseId, maximumBytes);
    } catch (error: unknown) {
      if (isCode(error, "ENOENT")) return { status: "missing" };
      return {
        status: "corrupt",
        reason: error instanceof Error ? error.message.slice(0, 220) : "Skill base could not be read safely.",
      };
    }
  };

  const publish = async (
    rawBaseId: string,
    revision: SkillRevision,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<SkillBasePublication> => {
    const baseId = safeBaseId(rawBaseId);
    const verifiedRevision = validateSnapshot(revision, files);
    const profileRoot = await getProfileRoot();
    await ensureDirectory(join(profileRoot, "omni"), 0o700);
    const basesRoot = await getBasesRoot();
    await ensureDirectory(basesRoot, 0o700);
    const basePath = join(basesRoot, baseId);
    try {
      await lstat(basePath);
      const existing = await verifyDirectorySnapshot(basePath, baseId);
      if (existing.status !== "ready" || !sameSnapshot(existing, { revision: verifiedRevision, files })) {
        throw new Error("Existing skill base id has conflicting or corrupt contents.");
      }
      return "existing";
    } catch (error: unknown) {
      if (!isCode(error, "ENOENT")) throw error;
    }

    const temporaryPath = join(basesRoot, `.${baseId}.${randomUUID()}.tmp`);
    const filesRoot = join(temporaryPath, "files");
    try {
      await mkdir(temporaryPath, { mode: 0o700 });
      await chmod(temporaryPath, 0o700);
      await mkdir(filesRoot, { mode: 0o700 });
      await chmod(filesRoot, 0o700);
      for (const [relativePath, bytes] of files) {
        if (!safeRelativeFilePath(relativePath)) throw new Error("Skill base contains an unsafe file path.");
        const target = join(filesRoot, ...relativePath.split("/"));
        if (!within(filesRoot, target)) throw new Error("Skill base file path escapes its directory.");
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await chmod(dirname(target), 0o700);
        await writeFile(target, Buffer.from(bytes), { mode: 0o600, flag: "wx" });
        await chmod(target, 0o600);
      }
      const manifest: Manifest = { version: 1, baseId, revision: verifiedRevision };
      const manifestPath = join(temporaryPath, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(manifestPath, 0o600);
      const prepared = await verifyDirectorySnapshot(temporaryPath, baseId);
      if (prepared.status !== "ready" || !sameSnapshot(prepared, { revision: verifiedRevision, files })) {
        throw new Error("Prepared skill base did not verify before publication.");
      }
      try {
        await rename(temporaryPath, basePath);
      } catch (error: unknown) {
        if (!isCode(error, "EEXIST") && !isCode(error, "ENOTEMPTY")) throw error;
        const existing = await verifyDirectorySnapshot(basePath, baseId);
        if (existing.status !== "ready" || !sameSnapshot(existing, { revision: verifiedRevision, files })) {
          throw new Error("Existing skill base id has conflicting or corrupt contents.");
        }
        return "existing";
      }
      await chmod(basePath, 0o700);
      return "created";
    } finally {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return { read, publish };
}
