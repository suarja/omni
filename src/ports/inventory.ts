export type InventoryFileType = "file" | "directory" | "symlink" | "other";

export type InventoryDirectoryEntry = Readonly<{
  name: string;
  type: InventoryFileType;
}>;

export type InventoryLstat = Readonly<{
  path: string;
  type: InventoryFileType;
  size: number;
}>;

export type InventoryRealpathEvidence = Readonly<{
  path: string;
  status: "inside-root" | "outside-root" | "broken";
  realpath?: string;
}>;

export type InventoryLinkEvidence = Readonly<{
  path: string;
  target: string;
  targetKind: "inside-root" | "outside-root";
}>;

export type InventoryFilesystemErrorCode =
  | "invalid-path"
  | "not-found"
  | "inaccessible"
  | "invalid-utf8"
  | "oversized"
  | "too-deep"
  | "too-many-entries"
  | "unsupported"
  | "io";

export class InventoryFilesystemError extends Error {
  public readonly operation: string;
  public readonly path: string;
  public readonly code: InventoryFilesystemErrorCode;

  public constructor(operation: string, path: string, code: InventoryFilesystemErrorCode, reason: string) {
    const safeOperation = sanitizeMessage(operation);
    const safePath = sanitizeErrorPath(path);
    const safeReason = sanitizeMessage(reason);
    super(`inventory filesystem ${safeOperation} failed for "${safePath}": ${safeReason}`);
    this.name = "InventoryFilesystemError";
    this.operation = safeOperation;
    this.path = safePath;
    this.code = code;
  }
}

function sanitizeMessage(value: string): string {
  return value.replace(/(?<![A-Za-z0-9._-])(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>]+/g, "<absolute-path>");
}

function sanitizeErrorPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    return "<absolute-path>";
  }

  return sanitizeMessage(normalized);
}

export type InventoryFilesystemOptions = Readonly<{
  maxDepth?: number;
  maxEntries?: number;
  maxFileBytes?: number;
}>;

/**
 * Main-process-only, read-only observation for a user-selected local root.
 * This is fail-closed best-effort containment for a single-user macOS scanner,
 * not a race-free hostile-concurrent-writer sandbox.
 */
export interface InventoryFilesystemPort {
  lstat(path: string): Promise<InventoryLstat>;
  listDirectory(path: string): Promise<readonly InventoryDirectoryEntry[]>;
  readlink(path: string): Promise<InventoryLinkEvidence>;
  realpathEvidence(path: string): Promise<InventoryRealpathEvidence>;
  /** Bounded metadata text read; keep internal and do not expose through IPC. */
  readText(path: string): Promise<string>;
  /** Bounded binary read for complete skill-tree fingerprints; main-process only. */
  readBytes(path: string): Promise<Uint8Array>;
  hash(path: string): Promise<string>;
}
