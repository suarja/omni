import { createHash } from "node:crypto";

import {
  SkillObservationError,
  type SkillObservationFilesystem,
  type SkillObservationErrorReason,
  type SkillObservationGrant,
} from "../../ports/skill-reconciliation";
import { createSkillRevision, type SkillFileRevision } from "../../domain/skill-reconciliation/revisions";
import type { SkillRevision, SkillTreeRead } from "../../domain/skill-reconciliation/types";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 512;
const MAX_FOLDER_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export type SkillScanBudget = { remainingBytes: number };
type ManifestEntry = Readonly<{ path: string; kind: "file" | "directory"; byteLength: number; identity: string }>;
type Manifest = Readonly<{ entries: readonly ManifestEntry[]; files: readonly ManifestEntry[] }>;

export type SkillTreeCapture =
  | Readonly<{
      status: "complete";
      folderPath: string;
      revision: SkillRevision;
      files: ReadonlyMap<string, Uint8Array>;
      manifest: Manifest;
    }>
  | Extract<SkillTreeRead, { status: "unavailable" }>;

function safeRelativeFolderPath(folderPath: string): boolean {
  const parts = folderPath.split("/");
  return (
    !folderPath.includes("\\") &&
    !folderPath.startsWith("/") &&
    !/^[A-Za-z]:/u.test(folderPath) &&
    parts.length > 0 &&
    parts.every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

function observationReason(error: unknown): SkillObservationErrorReason {
  return error instanceof SkillObservationError ? error.reason : "io";
}

function fail(reason: SkillObservationErrorReason): never {
  throw new SkillObservationError(reason);
}

function manifestEqual(left: Manifest, right: Manifest): boolean {
  return (
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const next = right.entries[index];
      return (
        next?.path === entry.path &&
        next.kind === entry.kind &&
        next.byteLength === entry.byteLength &&
        next.identity === entry.identity
      );
    })
  );
}

async function readManifest(
  filesystem: SkillObservationFilesystem,
  grant: SkillObservationGrant,
  folderPath: string,
): Promise<Manifest> {
  const entries: ManifestEntry[] = [];
  const files: ManifestEntry[] = [];
  const visit = async (relativePath: string): Promise<void> => {
    const node = await filesystem.lstat(grant, relativePath);
    if (node.kind === "symlink" || node.kind === "other") fail("unsafe-tree");
    if (node.kind === "directory") {
      if (relativePath !== folderPath) {
        entries.push({
          path: relativePath.slice(folderPath.length + 1),
          kind: "directory",
          byteLength: 0,
          identity: node.identity,
        });
      }
      const names = [...(await filesystem.listDirectory(grant, relativePath))].sort((left, right) =>
        left.localeCompare(right),
      );
      for (const name of names) {
        if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
          fail("unsafe-tree");
        }
        const childPath = `${relativePath}/${name}`;
        const child = await filesystem.lstat(grant, childPath);
        if (name === ".git" && child.kind === "directory") continue;
        await visit(childPath);
      }
      return;
    }
    if (node.kind !== "file") fail("unsafe-tree");
    const path = relativePath.slice(folderPath.length + 1);
    const file = { path, kind: "file" as const, byteLength: node.byteLength, identity: node.identity };
    entries.push(file);
    files.push(file);
  };
  const root = await filesystem.lstat(grant, folderPath);
  if (root.kind === "symlink" || root.kind === "other" || root.kind === "file") fail("unsafe-tree");
  if (root.kind !== "directory") fail("missing");
  await visit(folderPath);
  return {
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function checkLimits(manifest: Manifest, budget: SkillScanBudget): void {
  const bytes = manifest.files.reduce((total, file) => total + file.byteLength, 0);
  if (
    manifest.files.length > MAX_FILES ||
    manifest.files.some((file) => file.byteLength > MAX_FILE_BYTES) ||
    bytes > MAX_FOLDER_BYTES ||
    bytes > budget.remainingBytes
  ) {
    fail("limit");
  }
}

export async function captureSkillTree(
  grant: SkillObservationGrant,
  folderPath: string,
  budget: SkillScanBudget,
  filesystem: SkillObservationFilesystem,
  digest: (manifest: string) => string,
): Promise<SkillTreeCapture> {
  try {
    if (!safeRelativeFolderPath(folderPath) || budget.remainingBytes < 0 || budget.remainingBytes > MAX_SCAN_BYTES) {
      fail("unsafe-tree");
    }
    const manifest = await readManifest(filesystem, grant, folderPath);
    checkLimits(manifest, budget);
    const files = new Map<string, Uint8Array>();
    const revisions: SkillFileRevision[] = [];
    let byteCount = 0;
    for (const entry of manifest.files) {
      const fullPath = `${folderPath}/${entry.path}`;
      const result = await filesystem.readFile(grant, fullPath, entry.identity, MAX_FILE_BYTES);
      if (result.bytes.byteLength > MAX_FILE_BYTES) fail("limit");
      if (result.bytes.byteLength > budget.remainingBytes) {
        budget.remainingBytes = 0;
        fail("limit");
      }
      budget.remainingBytes -= result.bytes.byteLength;
      const afterRead = await filesystem.lstat(grant, fullPath);
      if (
        result.identity !== entry.identity ||
        afterRead.identity !== entry.identity ||
        afterRead.kind !== "file" ||
        result.bytes.byteLength !== entry.byteLength
      ) {
        fail("changed-during-read");
      }
      byteCount += result.bytes.byteLength;
      if (byteCount > MAX_FOLDER_BYTES) fail("limit");
      const bytes = Uint8Array.from(result.bytes);
      files.set(entry.path, bytes);
      revisions.push({
        path: entry.path,
        hash: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      });
    }
    const after = await readManifest(filesystem, grant, folderPath);
    if (!manifestEqual(manifest, after)) fail("changed-during-read");
    return {
      status: "complete",
      folderPath,
      revision: createSkillRevision(revisions, digest),
      files,
      manifest,
    };
  } catch (error: unknown) {
    return { status: "unavailable", reason: observationReason(error) };
  }
}

export async function revalidateSkillTree(
  capture: Extract<SkillTreeCapture, { status: "complete" }>,
  grant: SkillObservationGrant,
  filesystem: SkillObservationFilesystem,
): Promise<SkillTreeRead> {
  try {
    const current = await readManifest(filesystem, grant, capture.folderPath);
    if (!manifestEqual(capture.manifest, current)) fail("changed-during-read");
    return { status: "complete", revision: capture.revision };
  } catch (error: unknown) {
    return { status: "unavailable", reason: observationReason(error) };
  }
}
