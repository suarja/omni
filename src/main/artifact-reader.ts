import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { ReadArtifactRequest, ReadArtifactResponse } from "../shared/artifact-ipc";
import { parseReadArtifactRequest } from "../shared/artifact-ipc";
import type { RegistryGrant, RegistryGrantStore } from "./registry-ipc";
import { isMissing } from "./fs-optional";

export const MAX_ARTIFACT_BYTES = 256 * 1024;

function sameSubject(request: ReadArtifactRequest, grant: RegistryGrant): boolean {
  return request.kind === grant.subject.kind && request.id === grant.subject.id;
}
function isWithinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
function normalizePathInput(path: string): string {
  return path.replaceAll("\\", sep);
}
function isAbsolutePathInput(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("//");
}
async function rootIsCurrent(grant: RegistryGrant): Promise<boolean> {
  try {
    const canonicalRoot = await realpath(grant.root);
    const details = await stat(canonicalRoot);
    return (
      canonicalRoot === grant.root &&
      details.isDirectory() &&
      String(details.dev) === grant.device &&
      String(details.ino) === grant.inode
    );
  } catch {
    return false;
  }
}
async function realpathNearestExisting(path: string): Promise<string | undefined> {
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
async function readCanonicalFile(path: string): Promise<ReadArtifactResponse> {
  try {
    const file = await open(path, "r");
    try {
      const details = await file.stat();
      if (!details.isFile()) return { status: "unavailable", diagnostic: "The artifact is not a regular file." };
      if (details.size > MAX_ARTIFACT_BYTES)
        return { status: "too-large", byteLength: details.size, limit: MAX_ARTIFACT_BYTES };
      const buffer = Buffer.alloc(Math.min(details.size, MAX_ARTIFACT_BYTES));
      const result = await file.read(buffer, 0, buffer.length, 0);
      const finalSize = (await file.stat()).size;
      if (finalSize > MAX_ARTIFACT_BYTES)
        return { status: "too-large", byteLength: finalSize, limit: MAX_ARTIFACT_BYTES };
      const contentBuffer = result.bytesRead === buffer.length ? buffer : buffer.subarray(0, result.bytesRead);
      if (contentBuffer.includes(0)) return { status: "binary", byteLength: finalSize };
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(contentBuffer);
        return { status: "read", content, byteLength: finalSize, truncated: result.bytesRead < finalSize };
      } catch {
        return { status: "binary", byteLength: finalSize };
      }
    } finally {
      await file.close();
    }
  } catch (error: unknown) {
    return {
      status: "unavailable",
      diagnostic: isMissing(error) ? "The artifact is unavailable." : "The artifact cannot be read.",
    };
  }
}

export async function readGrantedArtifact(
  request: ReadArtifactRequest,
  grants: RegistryGrantStore,
): Promise<ReadArtifactResponse> {
  const parsed = parseReadArtifactRequest(request);
  const grant = grants.get(parsed.grantHandle);
  if (!grant || !sameSubject(parsed, grant)) return { status: "denied" };
  if (!(await rootIsCurrent(grant))) return { status: "denied" };
  const normalizedPath = normalizePathInput(parsed.relativePath);
  if (isAbsolutePathInput(normalizedPath)) return { status: "denied" };
  const lexicalPath = resolve(grant.root, normalizedPath);
  if (!isWithinRoot(grant.root, lexicalPath)) return { status: "denied" };
  const existingAncestor = await realpathNearestExisting(lexicalPath);
  if (existingAncestor && !isWithinRoot(grant.root, existingAncestor)) return { status: "denied" };
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error: unknown) {
    return {
      status: "unavailable",
      diagnostic: isMissing(error) ? "The artifact is unavailable." : "The artifact cannot be read.",
    };
  }
  if (!isWithinRoot(grant.root, canonicalPath)) return { status: "denied" };
  return readCanonicalFile(canonicalPath);
}
