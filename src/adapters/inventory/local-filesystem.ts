import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, open, opendir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { InventoryFilesystemError } from "../../ports/inventory";
import type {
  InventoryDirectoryEntry,
  InventoryFileType,
  InventoryFilesystemErrorCode,
  InventoryFilesystemOptions,
  InventoryFilesystemPort,
  InventoryLinkEvidence,
  InventoryLstat,
  InventoryRealpathEvidence,
} from "../../ports/inventory";

type NodeError = Error & { code?: string };

const MACOS_NOFOLLOW_ANY = 0x20000000;
const NOFOLLOW_ANY =
  (constants as typeof constants & { O_NOFOLLOW_ANY?: number }).O_NOFOLLOW_ANY ??
  (process.platform === "darwin" ? MACOS_NOFOLLOW_ANY : (constants.O_NOFOLLOW ?? 0));
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW_ANY;
const FILE_FLAGS = constants.O_RDONLY | NOFOLLOW_ANY | (constants.O_NONBLOCK ?? 0);

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error;
}

function safeErrorCode(error: unknown): InventoryFilesystemErrorCode {
  if (!isNodeError(error)) return "io";
  if (
    error.code === "invalid-path" ||
    error.code === "invalid-utf8" ||
    error.code === "oversized" ||
    error.code === "too-deep" ||
    error.code === "too-many-entries"
  ) {
    return error.code;
  }
  if (error.code === "ENOENT") return "not-found";
  if (error.code === "EACCES" || error.code === "EPERM") return "inaccessible";
  if (error.code === "EINVAL" || error.code === "EISDIR" || error.code === "ENOTDIR" || error.code === "ELOOP") {
    return "unsupported";
  }
  return "io";
}

const ERROR_REASONS: Readonly<Record<InventoryFilesystemErrorCode, string>> = {
  "invalid-path": "path is not allowed under the approved root",
  "not-found": "path does not exist",
  inaccessible: "path is not accessible",
  "invalid-utf8": "file is not valid UTF-8",
  oversized: "file exceeds the configured byte limit",
  "too-deep": "path exceeds the configured depth limit",
  "too-many-entries": "directory exceeds the configured entry limit",
  unsupported: "file type or path traversal is unsupported",
  io: "filesystem observation failed",
};

function asInventoryError(operation: string, path: string, error: unknown): InventoryFilesystemError {
  if (error instanceof InventoryFilesystemError) return error;
  const code = safeErrorCode(error);
  return new InventoryFilesystemError(operation, path, code, ERROR_REASONS[code]);
}

function invalidPathError(reason: string): NodeError {
  return Object.assign(new Error(reason), { code: "invalid-path" });
}

function codedError(code: InventoryFilesystemErrorCode, reason: string): NodeError {
  return Object.assign(new Error(reason), { code });
}

function classifiedError(
  operation: string,
  path: string,
  code: InventoryFilesystemErrorCode,
): InventoryFilesystemError {
  return new InventoryFilesystemError(operation, path, code, ERROR_REASONS[code]);
}

function normalizeErrorPath(lexicalRoot: string, path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (isAbsolute(path) || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    if (normalized.startsWith("/") && !/^[a-zA-Z]:\//.test(normalized)) {
      return relative(lexicalRoot, resolve(path)).split(sep).join("/") || ".";
    }
    return "<absolute-path>";
  }

  return normalized || ".";
}

async function observe<T>(
  lexicalRoot: string,
  operation: string,
  path: string,
  callback: () => Promise<T>,
): Promise<T> {
  const safePath = normalizeErrorPath(lexicalRoot, path);
  try {
    return await callback();
  } catch (error: unknown) {
    throw asInventoryError(operation, safePath, error);
  }
}

function isOutsideRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === ".." || distance.startsWith(`..${sep}`) || distance.startsWith(sep);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function typeForStats(stats: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): InventoryFileType {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeRequestPath(path: string): string {
  if (path.includes("\0")) {
    throw invalidPathError("path contains a null byte");
  }

  const normalized = path.replaceAll("\\", "/");
  if (isAbsolute(path) || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw invalidPathError("path must be relative");
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw invalidPathError("path contains lexical traversal");
  }

  return segments.join("/");
}

async function stableDirectoryStats(root: string, directoryPath: string): Promise<Stats> {
  const resolvedPath = await realpath(directoryPath);
  const stats = await stat(directoryPath);
  if (resolvedPath !== directoryPath || isOutsideRoot(root, resolvedPath) || !stats.isDirectory()) {
    throw invalidPathError("path crosses a replaced, external, or non-directory component");
  }
  return stats;
}

async function resolveSafeParent(root: string, segments: readonly string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    const candidate = resolve(current, segment);
    const handle = await open(candidate, DIRECTORY_FLAGS).catch((error: unknown) => {
      if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENOTDIR")) {
        throw invalidPathError("path crosses a symlink or non-directory component");
      }
      throw error;
    });
    try {
      const resolvedPath = await realpath(candidate);
      if (isOutsideRoot(root, resolvedPath)) {
        throw invalidPathError("path crosses an external directory");
      }
      if (!sameFile(await stat(resolvedPath), await handle.stat())) {
        throw invalidPathError("directory changed during observation");
      }
      current = resolvedPath;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return current;
}

type SafeLocation = Readonly<{
  normalizedPath: string;
  segments: readonly string[];
  parentPath: string;
  parentStats: Stats;
  candidatePath: string;
}>;

async function resolveSafeLocation(root: string, requestPath: string, maxDepth: number): Promise<SafeLocation> {
  const normalizedPath = normalizeRequestPath(requestPath);
  const segments = normalizedPath ? normalizedPath.split("/") : [];
  if (segments.length > maxDepth) {
    throw codedError("too-deep", "path exceeds the configured depth limit");
  }

  const parentPath = await resolveSafeParent(root, segments.slice(0, -1));
  const parentStats = await stableDirectoryStats(root, parentPath);
  return {
    normalizedPath,
    segments,
    parentPath,
    parentStats,
    candidatePath: segments.length ? resolve(parentPath, segments[segments.length - 1]) : root,
  };
}

async function verifyParentUnchanged(root: string, location: SafeLocation): Promise<void> {
  const afterStats = await stableDirectoryStats(root, location.parentPath);
  if (!sameFile(location.parentStats, afterStats))
    throw invalidPathError("parent directory changed during observation");
}

function linkEvidence(
  root: string,
  lexicalRoot: string,
  normalizedPath: string,
  rawTarget: string,
): InventoryLinkEvidence {
  const target = rawTarget.replaceAll("\\", "/");
  const isAbsoluteTarget = target.startsWith("/") || /^[a-zA-Z]:\//.test(target);
  const lexicalTarget = /^[a-zA-Z]:\//.test(target)
    ? undefined
    : isAbsoluteTarget
      ? resolve(target)
      : resolve(lexicalRoot, dirname(normalizedPath), target);
  let targetExists: string | undefined;
  if (lexicalTarget) {
    try {
      targetExists = realpathSync(lexicalTarget);
    } catch {
      targetExists = undefined;
    }
  }
  const canonicalTarget = targetExists ?? lexicalTarget;
  const insideCanonicalRoot = canonicalTarget ? !isOutsideRoot(root, canonicalTarget) : false;
  const insideLexicalRoot = lexicalTarget ? !isOutsideRoot(lexicalRoot, lexicalTarget) : false;

  if (!canonicalTarget || (!insideCanonicalRoot && !insideLexicalRoot)) {
    return {
      path: normalizedPath,
      target: "<outside-root>",
      targetKind: "outside-root",
    };
  }

  return {
    path: normalizedPath,
    target:
      relative(insideCanonicalRoot ? root : lexicalRoot, insideCanonicalRoot ? canonicalTarget : lexicalTarget!)
        .split(sep)
        .join("/") || ".",
    targetKind: "inside-root",
  };
}

async function readBoundedBytes(
  root: string,
  requestPath: string,
  maxDepth: number,
  operation: string,
  maxFileBytes: number,
): Promise<Buffer> {
  const location = await resolveSafeLocation(root, requestPath, maxDepth);
  if (!location.segments.length) {
    throw classifiedError(operation, location.normalizedPath, "unsupported");
  }

  const initialStats = await lstat(location.candidatePath);
  if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
    throw classifiedError(operation, location.normalizedPath, "unsupported");
  }

  const canonicalPath = await realpath(location.candidatePath);
  if (isOutsideRoot(root, canonicalPath)) {
    throw invalidPathError("target resolves outside the approved root");
  }
  const expectedStats = await stat(canonicalPath);
  if (!expectedStats.isFile()) {
    throw classifiedError(operation, location.normalizedPath, "unsupported");
  }
  if (expectedStats.size > maxFileBytes) {
    throw classifiedError(operation, location.normalizedPath, "oversized");
  }

  const handle = await open(canonicalPath, FILE_FLAGS);
  try {
    const openedStats = await handle.stat();
    if (!sameFile(expectedStats, openedStats)) {
      throw invalidPathError("file changed during observation");
    }
    if (openedStats.size > maxFileBytes) {
      throw classifiedError(operation, location.normalizedPath, "oversized");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = maxFileBytes + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      totalBytes += result.bytesRead;
      if (totalBytes > maxFileBytes) {
        throw classifiedError(operation, location.normalizedPath, "oversized");
      }
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function createLocalInventoryPort(
  approvedRoot: string,
  options: InventoryFilesystemOptions = {},
): InventoryFilesystemPort {
  if (!isAbsolute(approvedRoot)) {
    throw new InventoryFilesystemError("create", "<approved-root>", "invalid-path", "approved root must be absolute");
  }

  const lexicalRoot = resolve(approvedRoot);

  try {
    const root = realpathSync(approvedRoot);
    const rootStats = lstatSync(root);
    if (!rootStats.isDirectory()) {
      throw classifiedError("create", "<approved-root>", "unsupported");
    }

    const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    const maxDepth = options.maxDepth ?? 32;
    const maxEntries = options.maxEntries ?? 1000;
    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new Error("maxDepth must be a non-negative integer");
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
      throw new Error("maxFileBytes must be a positive integer");
    }

    return {
      async lstat(path): Promise<InventoryLstat> {
        return observe(lexicalRoot, "lstat", path, async () => {
          const location = await resolveSafeLocation(root, path, maxDepth);
          const stats = location.segments.length ? await lstat(location.candidatePath) : location.parentStats;
          await verifyParentUnchanged(root, location);
          return {
            path: location.normalizedPath,
            type: typeForStats(stats),
            size: stats.size,
          };
        });
      },

      async listDirectory(path): Promise<readonly InventoryDirectoryEntry[]> {
        return observe(lexicalRoot, "listDirectory", path, async () => {
          const location = await resolveSafeLocation(root, path, maxDepth);
          const initialStats = await lstat(location.candidatePath);
          if (initialStats.isSymbolicLink() || !initialStats.isDirectory()) {
            throw classifiedError("listDirectory", location.normalizedPath, "unsupported");
          }
          const canonicalPath = await realpath(location.candidatePath);
          if (isOutsideRoot(root, canonicalPath)) {
            throw invalidPathError("directory resolves outside the approved root");
          }
          const expectedStats = await stat(canonicalPath);
          const verificationHandle = await open(canonicalPath, DIRECTORY_FLAGS);
          try {
            const openedStats = await verificationHandle.stat();
            if (!sameFile(expectedStats, openedStats)) {
              throw invalidPathError("directory changed during observation");
            }
            const directory = await opendir(canonicalPath);

            try {
              const entries: InventoryDirectoryEntry[] = [];
              for await (const entry of directory) {
                if (entries.length >= maxEntries) {
                  throw codedError("too-many-entries", "directory exceeds the configured entry limit");
                }
                entries.push({ name: entry.name, type: typeForStats(entry) });
              }
              return entries.sort((left, right) => compareCodeUnits(left.name, right.name));
            } finally {
              await directory.close().catch(() => undefined);
            }
          } finally {
            await verificationHandle.close().catch(() => undefined);
          }
        });
      },

      async readlink(path): Promise<InventoryLinkEvidence> {
        return observe(lexicalRoot, "readlink", path, async () => {
          const location = await resolveSafeLocation(root, path, maxDepth);
          const rawTarget = await readlink(location.candidatePath, "utf8");
          await verifyParentUnchanged(root, location);
          return linkEvidence(root, lexicalRoot, location.normalizedPath, rawTarget);
        });
      },
      async realpathEvidence(path): Promise<InventoryRealpathEvidence> {
        return observe(lexicalRoot, "realpathEvidence", path, async () => {
          const location = await resolveSafeLocation(root, path, maxDepth);
          const initialStats = await lstat(location.candidatePath);
          try {
            const resolvedPath = await realpath(location.candidatePath);
            await verifyParentUnchanged(root, location);
            if (isOutsideRoot(root, resolvedPath)) {
              return { path: location.normalizedPath, status: "outside-root" };
            }
            return {
              path: location.normalizedPath,
              status: "inside-root",
              realpath: relative(root, resolvedPath).split(sep).join("/"),
            };
          } catch (error: unknown) {
            if (isNodeError(error) && error.code === "ENOENT" && initialStats.isSymbolicLink()) {
              return { path: location.normalizedPath, status: "broken" };
            }
            throw error;
          }
        });
      },

      async readText(path): Promise<string> {
        return observe(lexicalRoot, "readText", path, async () => {
          const normalizedPath = normalizeRequestPath(path);
          const bytes = await readBoundedBytes(root, normalizedPath, maxDepth, "readText", maxFileBytes);
          try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw classifiedError("readText", normalizedPath, "invalid-utf8");
          }
        });
      },

      async readBytes(path): Promise<Uint8Array> {
        return observe(lexicalRoot, "readBytes", path, async () => {
          const normalizedPath = normalizeRequestPath(path);
          return readBoundedBytes(root, normalizedPath, maxDepth, "readBytes", maxFileBytes);
        });
      },

      async hash(path): Promise<string> {
        return observe(lexicalRoot, "hash", path, async () => {
          const normalizedPath = normalizeRequestPath(path);
          const bytes = await readBoundedBytes(root, normalizedPath, maxDepth, "hash", maxFileBytes);
          return createHash("sha256").update(bytes).digest("hex");
        });
      },
    };
  } catch (error: unknown) {
    throw asInventoryError("create", "<approved-root>", error);
  }
}
