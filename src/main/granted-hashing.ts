import { createHash } from "node:crypto";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { RegistryGrant } from "./registry-ipc";
import { isMissing } from "./fs-optional";
import { getSharedIsolatedDirectoryReader } from "./isolated-directory-reader";

const MAX_HASH_BYTES = 1024 * 1024;
type HashResult =
  | Readonly<{
      status: "hashed";
      contentHash: string;
      byteLength: number;
      files?: readonly Readonly<{ relativePath: string; contentHash: string }>[];
    }>
  | Readonly<{ status: "too-large" | "denied" }>
  | Readonly<{ status: "unavailable"; reason?: string }>;

function isWithinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
function isAbsoluteInput(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("//");
}

async function nearestExisting(path: string): Promise<string | undefined> {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error: unknown) {
      if (!isMissing(error)) return undefined;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

export async function currentGrantRoot(grant: RegistryGrant): Promise<boolean> {
  try {
    const canonical = await realpath(grant.root);
    const details = await stat(canonical);
    return (
      canonical === grant.root &&
      details.isDirectory() &&
      String(details.dev) === grant.device &&
      String(details.ino) === grant.inode
    );
  } catch {
    return false;
  }
}

export async function resolveGrantedPath(
  grant: RegistryGrant,
  relativePath: string,
): Promise<string | "denied" | "unavailable"> {
  if (isAbsoluteInput(relativePath)) return "denied";
  const lexical = resolve(grant.root, relativePath.replaceAll("\\", sep));
  if (!isWithinRoot(grant.root, lexical)) return "denied";
  const ancestor = await nearestExisting(lexical);
  if (ancestor && !isWithinRoot(grant.root, ancestor)) return "denied";
  try {
    const canonical = await realpath(lexical);
    return isWithinRoot(grant.root, canonical) ? canonical : "denied";
  } catch (error: unknown) {
    return isMissing(error) ? "unavailable" : "unavailable";
  }
}

async function hashFile(path: string): Promise<HashResult> {
  try {
    const file = await open(path, "r");
    try {
      const details = await file.stat();
      if (!details.isFile()) return { status: "unavailable" };
      if (details.size > MAX_HASH_BYTES) return { status: "too-large" };
      const buffer = Buffer.alloc(details.size);
      const result = await file.read(buffer, 0, buffer.length, 0);
      const finalSize = (await file.stat()).size;
      if (finalSize > MAX_HASH_BYTES || result.bytesRead !== details.size || finalSize !== details.size)
        return { status: "too-large" };
      return {
        status: "hashed",
        contentHash: createHash("sha256").update(buffer).digest("hex"),
        byteLength: finalSize,
      };
    } finally {
      await file.close();
    }
  } catch {
    return { status: "unavailable" };
  }
}

async function hashDirectory(path: string, root: string, prefix: string, seen: Set<string>): Promise<HashResult> {
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!isWithinRoot(root, canonical) || !(await stat(canonical)).isDirectory()) return { status: "denied" };
  } catch {
    return { status: "unavailable" };
  }
  if (seen.has(canonical))
    return { status: "hashed", contentHash: createHash("sha256").digest("hex"), byteLength: 0, files: [] };
  seen.add(canonical);
  let entries;
  try {
    entries = [...(await getSharedIsolatedDirectoryReader().readDirectory(canonical))].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
      return { status: "unavailable", reason: error.code };
    }
    return { status: "unavailable" };
  }
  const lines: string[] = [];
  const files: { relativePath: string; contentHash: string }[] = [];
  let byteLength = 0;
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const child = resolve(canonical, entry.name);
    const childCanonical = await nearestExisting(child);
    if (!childCanonical || !isWithinRoot(root, childCanonical)) return { status: "denied" };
    const details = await stat(childCanonical).catch(() => undefined);
    if (!details) return { status: "unavailable" };
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (details.isDirectory()) {
      const nested = await hashDirectory(childCanonical, root, childPrefix, seen);
      if (nested.status !== "hashed") return nested;
      for (const file of nested.files ?? []) files.push(file);
      byteLength += nested.byteLength;
      for (const file of nested.files ?? []) lines.push(`${file.relativePath}:${file.contentHash}`);
    } else if (details.isFile()) {
      const hashed = await hashFile(childCanonical);
      if (hashed.status === "too-large") continue;
      if (hashed.status !== "hashed") return hashed;
      files.push({ relativePath: childPrefix, contentHash: hashed.contentHash });
      lines.push(`${childPrefix}:${hashed.contentHash}`);
      byteLength += hashed.byteLength;
    }
  }
  lines.sort((left, right) => left.localeCompare(right));
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    status: "hashed",
    contentHash: createHash("sha256").update(lines.join("\n"), "utf8").digest("hex"),
    byteLength,
    files,
  };
}

export async function hashGrantedPath(grant: RegistryGrant, relativePath: string): Promise<HashResult> {
  const location = await resolveGrantedPath(grant, relativePath);
  if (location === "denied") return { status: "denied" };
  if (location === "unavailable") return { status: "unavailable" };
  const details = await stat(location).catch(() => undefined);
  if (!details) return { status: "unavailable" };
  return details.isDirectory() ? hashDirectory(location, grant.root, "", new Set()) : hashFile(location);
}

export type GrantedTargetObservation =
  | Readonly<{
      status: "observed";
      exists: boolean;
      contentHash?: string;
      symlinkTarget?: string;
      unit: "folder" | "file";
    }>
  | Readonly<{ status: "denied" | "unavailable" }>;

export async function observeGrantedTarget(
  grant: RegistryGrant,
  relativePath: string,
  unit: "folder" | "file",
): Promise<GrantedTargetObservation> {
  if (isAbsoluteInput(relativePath)) return { status: "denied" };
  const lexical = resolve(grant.root, relativePath.replaceAll("\\", sep));
  if (!isWithinRoot(grant.root, lexical)) return { status: "denied" };
  const ancestor = await nearestExisting(lexical);
  if (ancestor && !isWithinRoot(grant.root, ancestor)) return { status: "denied" };
  const link = await lstat(lexical)
    .then(async (details) => (details.isSymbolicLink() ? readlink(lexical, "utf8") : undefined))
    .catch(() => undefined);
  const location = await resolveGrantedPath(grant, relativePath);
  if (location === "denied") return { status: "denied" };
  if (location === "unavailable") {
    try {
      await import("node:fs/promises").then(({ lstat }) => lstat(lexical));
      return { status: "observed", exists: true, ...(link ? { symlinkTarget: link } : {}), unit };
    } catch {
      return { status: "observed", exists: false, unit };
    }
  }
  const hashed = await hashGrantedPath(grant, relativePath);
  if (hashed.status !== "hashed") return { status: hashed.status === "denied" ? "denied" : "unavailable" };
  const canonicalLinkTarget = link ? await realpath(location).catch(() => undefined) : undefined;
  const safeLink =
    canonicalLinkTarget && isWithinRoot(grant.root, canonicalLinkTarget)
      ? relative(grant.root, canonicalLinkTarget).split(sep).join("/")
      : undefined;
  return {
    status: "observed",
    exists: true,
    contentHash: hashed.contentHash,
    ...(safeLink ? { symlinkTarget: safeLink } : {}),
    unit,
  };
}
