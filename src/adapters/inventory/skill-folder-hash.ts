import { createHash } from "node:crypto";

import type { InventoryFilesystemPort } from "../../ports/inventory";

const FOLDER_MAX_FILES = 512;
const FOLDER_MAX_BYTES = 16 * 1024 * 1024;
const SCAN_MAX_BYTES = 32 * 1024 * 1024;
const FILE_MAX_BYTES = 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

export type SkillFolderBudget = { remainingBytes: number };
export type SkillFolderFingerprint =
  | Readonly<{ status: "hashed"; hash: string }>
  | Readonly<{ status: "unverified"; reason: "budget" | "unsafe-tree" | "unavailable" }>;

type FingerprintFile = Readonly<{ relativePath: string; bytes: Uint8Array }>;
type Enumeration = Readonly<{ files: readonly FingerprintFile[]; byteCount: number }>;
type FingerprintFailure = Readonly<{ reason: "budget" | "unsafe-tree" | "unavailable" }>;

function isFailure(value: Enumeration | FingerprintFailure): value is FingerprintFailure {
  return "reason" in value;
}

function failureReason(error: unknown): FingerprintFailure["reason"] {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (["too-deep", "too-many-entries", "oversized"].includes(code)) return "budget";
  if (["invalid-path", "unsupported"].includes(code)) return "unsafe-tree";
  return "unavailable";
}

async function enumerateFiles(
  filesystem: InventoryFilesystemPort,
  folder: string,
  budget: SkillFolderBudget,
): Promise<Enumeration | FingerprintFailure> {
  const files: FingerprintFile[] = [];
  let folderBytes = 0;

  const visit = async (path: string): Promise<FingerprintFailure | undefined> => {
    let location;
    try {
      location = await filesystem.lstat(path);
    } catch (error: unknown) {
      return { reason: failureReason(error) };
    }
    if (location.type === "symlink" || location.type === "other") return { reason: "unsafe-tree" };
    if (location.type === "file") {
      if (files.length >= FOLDER_MAX_FILES || location.size > FILE_MAX_BYTES) return { reason: "budget" };
      if (location.size > FOLDER_MAX_BYTES - folderBytes || location.size > budget.remainingBytes) {
        return { reason: "budget" };
      }
      let bytes: Uint8Array;
      try {
        bytes = await filesystem.readBytes(path);
      } catch (error: unknown) {
        return { reason: failureReason(error) };
      }
      if (
        files.length + 1 > FOLDER_MAX_FILES ||
        bytes.byteLength > FOLDER_MAX_BYTES - folderBytes ||
        bytes.byteLength > budget.remainingBytes
      ) {
        return { reason: "budget" };
      }
      folderBytes += bytes.byteLength;
      budget.remainingBytes -= bytes.byteLength;
      files.push({ relativePath: path.slice(folder.length + 1), bytes });
      return undefined;
    }
    if (location.type !== "directory") return { reason: "unsafe-tree" };

    let entries;
    try {
      entries = await filesystem.listDirectory(path);
    } catch (error: unknown) {
      return { reason: failureReason(error) };
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.type === "directory" && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const error = await visit(`${path}/${entry.name}`);
      if (error) return error;
    }
    return undefined;
  };

  const root = await visit(folder);
  return root ?? { files, byteCount: folderBytes };
}

function hashFiles(files: readonly FingerprintFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath, "utf8");
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

export async function hashSkillFolder(
  filesystem: InventoryFilesystemPort,
  folder: string,
  budget: SkillFolderBudget,
): Promise<SkillFolderFingerprint> {
  if (!Number.isInteger(budget.remainingBytes) || budget.remainingBytes < 0 || budget.remainingBytes > SCAN_MAX_BYTES) {
    return { status: "unverified", reason: "budget" };
  }
  const result = await enumerateFiles(filesystem, folder, budget);
  if (isFailure(result)) return { status: "unverified", reason: result.reason };
  return { status: "hashed", hash: hashFiles(result.files) };
}

export type SkillFolderInspection =
  | Readonly<{ status: "hashed"; hash: string; files: number; skillMd: Uint8Array | undefined }>
  | Extract<SkillFolderFingerprint, { status: "unverified" }>;

export async function inspectSkillFolder(
  filesystem: InventoryFilesystemPort,
  folder: string,
  budget: SkillFolderBudget,
): Promise<SkillFolderInspection> {
  if (!Number.isInteger(budget.remainingBytes) || budget.remainingBytes < 0 || budget.remainingBytes > SCAN_MAX_BYTES)
    return { status: "unverified", reason: "budget" };
  const result = await enumerateFiles(filesystem, folder, budget);
  if (isFailure(result)) return { status: "unverified", reason: result.reason };
  return {
    status: "hashed",
    hash: hashFiles(result.files),
    files: result.files.length,
    skillMd: result.files.find((file) => file.relativePath === "SKILL.md")?.bytes,
  };
}
