import { randomUUID } from "node:crypto";
import { chmod, mkdir, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";

import type { OperationReceipt } from "../shared/operations-ipc";
import { parseListOperationsResponse } from "../shared/operations-receipt-parsers";

export type OperationStoreLoadResult =
  | Readonly<{ status: "ready"; receipts: readonly OperationReceipt[] }>
  | Readonly<{ status: "corrupt"; diagnostic: string; recoveryAvailable: boolean }>;
export type OperationStoreMutationResult = OperationStoreLoadResult;

type OperationStoreState = Readonly<{ schemaVersion: 1; receipts: readonly OperationReceipt[] }>;
const storesByPath = new Map<string, OperationStore>();

export interface OperationStore {
  read(): Promise<OperationStoreLoadResult>;
  append(receipt: OperationReceipt): Promise<OperationStoreMutationResult>;
  markRestored(operationId: string): Promise<OperationStoreMutationResult>;
}

class OperationPathError extends Error {}

function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function pathStatus(filePath: string, label: string): Promise<"absent" | "present"> {
  try {
    const details = await lstat(filePath);
    if (details.isSymbolicLink()) throw new OperationPathError(`${label} must not be a symbolic link.`);
    if (!details.isFile()) throw new OperationPathError(`${label} must be a regular file.`);
    return "present";
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return "absent";
    throw error;
  }
}

// Files written between 36-pre and its fix (2026-09-15) hold `restore-add-to-project` receipts
// with a plan-shaped `git.warnings` field the reader rejects. Reading drops that one field on
// that one kind, nothing else; the next write persists the clean shape. Remove once no such
// file can exist (the owner's machine was the only one).
function repairKnownReceiptShape(receipt: unknown): unknown {
  if (typeof receipt !== "object" || receipt === null) return receipt;
  const record = receipt as Record<string, unknown>;
  const git = record.git;
  if (record.kind !== "restore-add-to-project" || typeof git !== "object" || git === null || !("warnings" in git))
    return receipt;
  const { warnings: _warnings, ...cleanGit } = git as Record<string, unknown>;
  return { ...record, git: cleanGit };
}

function parseState(value: unknown): OperationStoreState {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Operation store record is invalid.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !["schemaVersion", "receipts"].includes(key)))
    throw new Error("Operation store contains an unknown field.");
  if (record.schemaVersion !== 1 || !Array.isArray(record.receipts))
    throw new Error("Operation store schema is unsupported.");
  const parsed = parseListOperationsResponse({
    status: "ready",
    receipts: record.receipts.map(repairKnownReceiptShape),
  });
  return { schemaVersion: 1, receipts: parsed.receipts };
}

function diagnostic(error: unknown): string {
  if (error instanceof OperationPathError) return error.message;
  if (error instanceof SyntaxError) return "Operations JSON is invalid.";
  return "Operations store could not be read safely.";
}

async function parseFile(filePath: string): Promise<OperationStoreState> {
  return parseState(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

async function hasValidBackup(filePath: string): Promise<boolean> {
  try {
    if ((await pathStatus(backupPath(filePath), "Operations backup")) === "absent") return false;
    await parseFile(backupPath(filePath));
    return true;
  } catch {
    return false;
  }
}

async function load(filePath: string): Promise<OperationStoreLoadResult> {
  try {
    const main = await pathStatus(filePath, "Operations file");
    const backup = await pathStatus(backupPath(filePath), "Operations backup");
    if (main === "absent" && backup === "absent") return { status: "ready", receipts: [] };
    if (main === "absent")
      return {
        status: "corrupt",
        diagnostic: "Operations file is missing; a valid backup is available.",
        recoveryAvailable: await hasValidBackup(filePath),
      };
    const state = await parseFile(filePath);
    await chmod(filePath, 0o600);
    return { status: "ready", receipts: state.receipts };
  } catch (error: unknown) {
    return { status: "corrupt", diagnostic: diagnostic(error), recoveryAvailable: await hasValidBackup(filePath) };
  }
}

async function writeAtomically(filePath: string, state: OperationStoreState): Promise<void> {
  await pathStatus(filePath, "Operations target");
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

// A receipt the store's own reader would reject must never reach the file: the writer gets an
// error (its operation is reported failed), the file and its backup stay readable. Found on
// 2026-09-15 when a restore receipt carried a plan-shaped `git` field and made the whole
// store unreadable on the next launch.
function assertStorable(receipt: OperationReceipt): void {
  try {
    parseState({ schemaVersion: 1, receipts: [receipt] });
  } catch (error: unknown) {
    throw new Error(`Receipt cannot be stored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createOperationStore(filePath: string): OperationStore {
  const resolvedFilePath = resolve(filePath);
  const existing = storesByPath.get(resolvedFilePath);
  if (existing) return existing;
  let loaded: OperationStoreLoadResult | undefined;
  let loadPromise: Promise<OperationStoreLoadResult> | undefined;
  let writeQueue = Promise.resolve();
  const ensureLoaded = async (): Promise<OperationStoreLoadResult> => {
    loaded ??= await (loadPromise ??= load(resolvedFilePath));
    return loaded;
  };
  const append = async (receipt: OperationReceipt): Promise<OperationStoreMutationResult> => {
    assertStorable(receipt);
    const result = writeQueue.then(async () => {
      const current = await ensureLoaded();
      if (current.status === "corrupt") return current;
      const next: OperationStoreState = {
        schemaVersion: 1,
        receipts: [receipt, ...current.receipts.filter((saved) => saved.operationId !== receipt.operationId)],
      };
      await pathStatus(resolvedFilePath, "Operations file");
      await pathStatus(backupPath(resolvedFilePath), "Operations backup");
      await writeAtomically(backupPath(resolvedFilePath), next);
      await writeAtomically(resolvedFilePath, next);
      loaded = { status: "ready", receipts: next.receipts };
      return loaded;
    });
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const markRestored = async (operationId: string): Promise<OperationStoreMutationResult> => {
    const result = writeQueue.then(async () => {
      const current = await ensureLoaded();
      if (current.status === "corrupt") return current;
      const found = current.receipts.find((receipt) => receipt.operationId === operationId);
      if (!found) return current;
      const next: OperationStoreState = {
        schemaVersion: 1,
        receipts: current.receipts.map((receipt) =>
          receipt.operationId === operationId ? { ...receipt, restored: true } : receipt,
        ),
      };
      await pathStatus(resolvedFilePath, "Operations file");
      await pathStatus(backupPath(resolvedFilePath), "Operations backup");
      await writeAtomically(backupPath(resolvedFilePath), next);
      await writeAtomically(resolvedFilePath, next);
      loaded = { status: "ready", receipts: next.receipts };
      return loaded;
    });
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const store: OperationStore = { read: ensureLoaded, append, markRestored };
  storesByPath.set(resolvedFilePath, store);
  return store;
}
