import { randomUUID } from "node:crypto";
import { chmod, mkdir, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  parseRegistryState,
  type CorruptRegistryResult,
  type RegistryLoadResult,
  type RegistryMutationResult,
  type RegistryState,
} from "../../domain/project-source-registry";
import type { ProjectSourceRegistryStore, RegistryChange } from "../../ports/project-source-registry";

const EMPTY_STATE: RegistryState = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  projects: Object.freeze([]),
  sources: Object.freeze([]),
});
const storesByPath = new Map<string, ProjectSourceRegistryStore>();

class RegistryPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RegistryPathError";
  }
}

function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}

async function pathStatus(filePath: string, label: string): Promise<"absent" | "present"> {
  try {
    const details = await lstat(filePath);
    if (details.isSymbolicLink()) {
      throw new RegistryPathError(`${label} must not be a symbolic link.`);
    }
    if (!details.isFile()) {
      throw new RegistryPathError(`${label} must be a regular file.`);
    }
    return "present";
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) {
      return "absent";
    }
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  await pathStatus(filePath, "Registry target");
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function parseFile(filePath: string): Promise<RegistryState> {
  const content = await readFile(filePath, "utf8");
  return parseRegistryState(JSON.parse(content) as unknown);
}

async function hasValidBackup(filePath: string): Promise<boolean> {
  const file = backupPath(filePath);
  try {
    if ((await pathStatus(file, "Registry backup")) === "absent") {
      return false;
    }
  } catch {
    return false;
  }
  try {
    await parseFile(file);
    return true;
  } catch {
    return false;
  }
}

function diagnostic(error: unknown): string {
  if (error instanceof RegistryPathError) {
    return error.message;
  }
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code) {
    return `Registry file could not be accessed (${code}).`;
  }
  if (error instanceof SyntaxError) {
    return `Registry JSON is invalid: ${error.message}`;
  }
  if (error instanceof Error) {
    return `Registry record is invalid: ${error.message}`;
  }
  return "Registry could not be read.";
}

async function load(filePath: string): Promise<RegistryLoadResult> {
  let status: "absent" | "present";
  try {
    status = await pathStatus(filePath, "Registry file");
  } catch (error: unknown) {
    return {
      status: "corrupt",
      diagnostic: diagnostic(error),
      recoveryAvailable: await hasValidBackup(filePath),
    };
  }
  let backupStatus: "absent" | "present";
  try {
    backupStatus = await pathStatus(backupPath(filePath), "Registry backup");
  } catch (error: unknown) {
    return {
      status: "corrupt",
      diagnostic: diagnostic(error),
      recoveryAvailable: await hasValidBackup(filePath),
    };
  }
  if (status === "absent" && backupStatus === "absent") {
    return { status: "ready", state: EMPTY_STATE };
  }
  if (status === "absent") {
    try {
      await parseFile(backupPath(filePath));
      return {
        status: "corrupt",
        diagnostic: "Registry file is missing; a valid backup is available.",
        recoveryAvailable: true,
      };
    } catch (error: unknown) {
      return {
        status: "corrupt",
        diagnostic: diagnostic(error),
        recoveryAvailable: false,
      };
    }
  }
  try {
    const state = await parseFile(filePath);
    await chmod(filePath, 0o600);
    return { status: "ready", state };
  } catch (error: unknown) {
    return {
      status: "corrupt",
      diagnostic: diagnostic(error),
      recoveryAvailable: await hasValidBackup(filePath),
    };
  }
}

function enqueue<T>(tail: Promise<void>, operation: () => Promise<T>): { result: Promise<T>; nextTail: Promise<void> } {
  const result = tail.then(operation);
  const nextTail = result.then(
    () => undefined,
    () => undefined,
  );
  return { result, nextTail };
}

export function createLocalJsonRegistryStore(filePath: string): ProjectSourceRegistryStore {
  const resolvedFilePath = resolve(filePath);
  const existingStore = storesByPath.get(resolvedFilePath);
  if (existingStore) {
    return existingStore;
  }
  let loaded: RegistryLoadResult | undefined;
  let loadPromise: Promise<RegistryLoadResult> | undefined;
  let writeQueue = Promise.resolve();

  const ensureLoaded = async (): Promise<RegistryLoadResult> => {
    if (loaded) {
      return loaded;
    }
    loadPromise ??= load(resolvedFilePath);
    loaded = await loadPromise;
    return loaded;
  };

  const mutate = async (expectedRevision: number, change: RegistryChange): Promise<RegistryMutationResult> => {
    const queued = enqueue(writeQueue, async (): Promise<RegistryMutationResult> => {
      const current = await ensureLoaded();
      if (current.status === "corrupt") {
        return current satisfies CorruptRegistryResult;
      }
      if (current.state.revision !== expectedRevision) {
        return {
          status: "revision-conflict" as const,
          expected: expectedRevision,
          actual: current.state.revision,
        };
      }
      const proposed = change(current.state);
      const next = parseRegistryState({
        ...proposed,
        schemaVersion: 1,
        revision: current.state.revision + 1,
      });
      const content = `${JSON.stringify(next, null, 2)}\n`;
      await pathStatus(resolvedFilePath, "Registry file");
      await pathStatus(backupPath(resolvedFilePath), "Registry backup");
      await writeAtomically(backupPath(resolvedFilePath), content);
      const validatedBackup = await parseFile(backupPath(resolvedFilePath));
      if (validatedBackup.revision !== next.revision) {
        throw new Error("Registry backup validation failed.");
      }
      await writeAtomically(resolvedFilePath, content);
      loaded = { status: "ready", state: next };
      return { status: "ready" as const, state: next };
    });
    writeQueue = queued.nextTail;
    return queued.result;
  };

  const store: ProjectSourceRegistryStore = {
    read: ensureLoaded,
    mutate,
  };
  storesByPath.set(resolvedFilePath, store);
  return store;
}

export const createLocalJsonRegistry = createLocalJsonRegistryStore;
