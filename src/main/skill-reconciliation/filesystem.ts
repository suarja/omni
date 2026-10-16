import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  SkillObservationError,
  type SkillObservationFilesystem,
  type SkillFilesystemNode,
  type SkillObservationGrant,
} from "../../ports/skill-reconciliation";

function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}

function safeRelativePath(path: string): boolean {
  return (
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

function identity(details: BigIntStats): string {
  return [details.dev, details.ino, details.mode, details.size, details.mtimeNs, details.ctimeNs].join(":");
}

function kind(details: BigIntStats): SkillFilesystemNode["kind"] {
  if (details.isSymbolicLink()) return "symlink";
  if (details.isFile()) return "file";
  if (details.isDirectory()) return "directory";
  return "other";
}

function failure(error: unknown): SkillObservationError {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOENT" || code === "ENOTDIR") return new SkillObservationError("missing");
  if (code === "EACCES" || code === "EPERM") return new SkillObservationError("denied");
  if (code === "ELOOP") return new SkillObservationError("unsafe-tree");
  return new SkillObservationError("io");
}

function absolutePath(grant: SkillObservationGrant, path: string): string {
  if (!safeRelativePath(path)) throw new SkillObservationError("unsafe-tree");
  const candidate = resolve(grant.root, path.split("/").join(sep));
  if (!withinRoot(grant.root, candidate)) throw new SkillObservationError("denied");
  return candidate;
}

async function ensureContained(grant: SkillObservationGrant, candidate: string): Promise<void> {
  try {
    const canonicalRoot = await realpath(grant.root);
    const rootDetails = await stat(canonicalRoot, { bigint: true });
    if (
      canonicalRoot !== grant.root ||
      !rootDetails.isDirectory() ||
      rootDetails.dev.toString() !== grant.device ||
      rootDetails.ino.toString() !== grant.inode ||
      grant.expiresAt <= Date.now()
    ) {
      throw new SkillObservationError("denied");
    }
    const canonical = await realpath(candidate);
    if (!withinRoot(grant.root, canonical)) throw new SkillObservationError("denied");
    // A contained alias is still a symlinked tree, not an independent physical copy.
    if (canonical !== candidate) throw new SkillObservationError("unsafe-tree");
  } catch (error: unknown) {
    if (error instanceof SkillObservationError) throw error;
    throw failure(error);
  }
}

async function lstatGranted(grant: SkillObservationGrant, relativePath: string): Promise<SkillFilesystemNode> {
  const candidate = absolutePath(grant, relativePath);
  try {
    const details = await lstat(candidate, { bigint: true });
    await ensureContained(grant, details.isSymbolicLink() ? grant.root : candidate);
    return { kind: kind(details), byteLength: Number(details.size), identity: identity(details) };
  } catch (error: unknown) {
    if (error instanceof SkillObservationError) throw error;
    throw failure(error);
  }
}

export const strictSkillObservationFilesystem: SkillObservationFilesystem = {
  lstat: lstatGranted,
  async listDirectory(grant, relativePath) {
    const candidate = absolutePath(grant, relativePath);
    await ensureContained(grant, candidate);
    try {
      return (await readdir(candidate, { withFileTypes: true })).map((entry) => entry.name);
    } catch (error: unknown) {
      throw failure(error);
    }
  },
  async readFile(grant, relativePath, expectedIdentity, maximumBytes) {
    const candidate = absolutePath(grant, relativePath);
    await ensureContained(grant, candidate);
    if (typeof constants.O_NOFOLLOW !== "number") throw new SkillObservationError("unsafe-tree");
    let handle;
    try {
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || identity(before) !== expectedIdentity) {
        throw new SkillObservationError("changed-during-read");
      }
      if (before.size > BigInt(maximumBytes)) throw new SkillObservationError("limit");
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) throw new SkillObservationError("changed-during-read");
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (identity(after) !== expectedIdentity || !after.isFile()) {
        throw new SkillObservationError("changed-during-read");
      }
      return { bytes, identity: identity(after) };
    } catch (error: unknown) {
      if (error instanceof SkillObservationError) throw error;
      throw failure(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};
