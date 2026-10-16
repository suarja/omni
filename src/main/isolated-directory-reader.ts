import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { resolveResource } from "./omni-resources";

export type DirectoryEntry = Readonly<{
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}>;

export type IsolatedDirectoryReader = Readonly<{
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  dispose(): Promise<void>;
}>;

export type IsolatedDirectoryReaderOptions = Readonly<{
  executablePath?: string;
  spawnProcess?: typeof nodeSpawn;
  now?: () => number;
}>;

type WorkerResponse =
  | Readonly<{
      id: string;
      ok: true;
      entries: readonly DirectoryEntry[];
    }>
  | Readonly<{
      id: string;
      ok: false;
      error: Readonly<{ code: string }>;
    }>;

type Job = {
  id: string;
  path: string;
  resolve(entries: readonly DirectoryEntry[]): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};

type WorkerState = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  close(): void;
  buffer: string;
  failed: boolean;
};

const MAX_ACTIVE = 2;
const MAX_QUEUE = 64;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 3_000;
const FAILURE_COOLDOWN_MS = 5_000;
const WORKER_RELATIVE_PATH = "resources/directory-reader.mjs";

export class IsolatedDirectoryReaderError extends Error {
  readonly code: string;
  readonly operation = "readdir";
  readonly path: string;
  readonly recovery: string;

  constructor(code: string, path: string, message?: string) {
    const recovery =
      code === "directory-reader-busy" || code === "directory-reader-cooldown"
        ? "Retry shortly."
        : code === "directory-entry-limit" ||
            code === "directory-response-limit" ||
            code === "directory-reader-response-limit"
          ? "Reduce the directory contents before retrying."
          : "Retry after the directory reader recovers.";
    super(message ?? `Isolated directory read failed (${code}) for ${path}. ${recovery}`);
    this.name = "IsolatedDirectoryReaderError";
    this.code = code;
    this.path = path;
    this.recovery = recovery;
  }
}

export function isIsolatedDirectoryReaderError(error: unknown): error is IsolatedDirectoryReaderError {
  return error instanceof IsolatedDirectoryReaderError;
}

export function isOptionalDirectoryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM";
}

function serviceError(code: string, path: string): IsolatedDirectoryReaderError {
  return new IsolatedDirectoryReaderError(code, path);
}

function validComponent(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0")
  );
}

function validateResponse(value: unknown, id: string, path: string): WorkerResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw serviceError("directory-reader-protocol", path);
  const response = value as Record<string, unknown>;
  if (response.id !== id || typeof response.ok !== "boolean") throw serviceError("directory-reader-protocol", path);
  if (response.ok === false) {
    if (
      Object.keys(response).sort().join(",") !== "error,id,ok" ||
      typeof response.error !== "object" ||
      response.error === null ||
      Array.isArray(response.error) ||
      Object.keys(response.error as Record<string, unknown>).join(",") !== "code" ||
      typeof (response.error as Record<string, unknown>).code !== "string"
    )
      throw serviceError("directory-reader-protocol", path);
    const code = (response.error as Record<string, unknown>).code as string;
    if (!/^(?:[A-Z][A-Z0-9_]{1,63}|directory-[a-z0-9-]{1,64})$/u.test(code))
      throw serviceError("directory-reader-protocol", path);
    return { id, ok: false, error: { code } };
  }
  if (Object.keys(response).sort().join(",") !== "entries,id,ok") throw serviceError("directory-reader-protocol", path);
  if (!Array.isArray(response.entries) || response.entries.length > MAX_DIRECTORY_ENTRIES)
    throw serviceError("directory-reader-response-limit", path);
  const entries = response.entries.map((entry): DirectoryEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw serviceError("directory-reader-protocol", path);
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(",") !== "isDirectory,isFile,isSymbolicLink,name" ||
      !validComponent(item.name) ||
      typeof item.isFile !== "boolean" ||
      typeof item.isDirectory !== "boolean" ||
      typeof item.isSymbolicLink !== "boolean"
    )
      throw serviceError("directory-reader-protocol", path);
    return {
      name: item.name,
      isFile: item.isFile,
      isDirectory: item.isDirectory,
      isSymbolicLink: item.isSymbolicLink,
    };
  });
  return { id, ok: true, entries };
}

function responseBytes(response: WorkerResponse): number {
  return Buffer.byteLength(JSON.stringify(response), "utf8") + 1;
}

function asNativeError(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`Directory read failed (${code}) for ${path}.`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

export function createIsolatedDirectoryReader(options: IsolatedDirectoryReaderOptions = {}): IsolatedDirectoryReader {
  const spawnProcess = options.spawnProcess ?? nodeSpawn;
  const executablePath = options.executablePath ?? process.execPath;
  const now = options.now ?? Date.now;
  const scriptPath = resolveResource(WORKER_RELATIVE_PATH);
  const queue: Job[] = [];
  const active = new Map<string, Job>();
  const inFlightByPath = new Map<string, Promise<readonly DirectoryEntry[]>>();
  let worker: WorkerState | undefined;
  let reaping: Promise<void> | undefined;
  let cooldownUntil = 0;
  let disposed = false;

  const rejectJobs = (errorForPath: (path: string) => Error): void => {
    for (const job of [...active.values(), ...queue]) {
      if (job.timer) clearTimeout(job.timer);
      inFlightByPath.delete(job.path);
      job.reject(errorForPath(job.path));
    }
    active.clear();
    queue.length = 0;
  };

  const failWorker = (state: WorkerState, code: string, failedPath?: string): void => {
    if (state.failed) return;
    state.failed = true;
    cooldownUntil = Math.max(cooldownUntil, now() + FAILURE_COOLDOWN_MS);
    rejectJobs((path) => serviceError(failedPath === path ? code : "directory-reader-crashed", path));
    reaping = state.closed;
    try {
      state.child.kill("SIGKILL");
    } catch {
      // The close event remains the authority for process reaping.
    }
  };

  const dispatchQueued = (): void => {
    if (disposed || !queue.length || now() < cooldownUntil || reaping) return;
    let state = worker;
    if (!state) {
      try {
        state = startWorker();
      } catch {
        cooldownUntil = Math.max(cooldownUntil, now() + FAILURE_COOLDOWN_MS);
        rejectJobs((path) => serviceError("directory-reader-crashed", path));
        return;
      }
    }
    while (active.size < MAX_ACTIVE && queue.length > 0) {
      const job = queue.shift()!;
      active.set(job.id, job);
      job.timer = setTimeout(() => failWorker(state!, "directory-reader-timeout", job.path), READ_TIMEOUT_MS);
      try {
        state.child.stdin.write(`${JSON.stringify({ id: job.id, path: job.path })}\n`, (error) => {
          if (error) failWorker(state!, "directory-reader-crashed", job.path);
        });
      } catch {
        failWorker(state, "directory-reader-crashed", job.path);
        return;
      }
    }
  };

  function finishJob(job: Job, response: WorkerResponse): void {
    if (!active.has(job.id)) return;
    active.delete(job.id);
    if (job.timer) clearTimeout(job.timer);
    inFlightByPath.delete(job.path);
    if (response.ok) job.resolve(response.entries);
    else if (response.error.code.startsWith("directory-")) job.reject(serviceError(response.error.code, job.path));
    else job.reject(asNativeError(response.error.code, job.path));
    dispatchQueued();
  }

  function receiveLine(state: WorkerState, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      failWorker(state, "directory-reader-protocol");
      return;
    }
    const rawId =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).id
        : undefined;
    const job = typeof rawId === "string" ? active.get(rawId) : undefined;
    if (!job) {
      failWorker(state, "directory-reader-protocol");
      return;
    }
    try {
      const response = validateResponse(parsed, job.id, job.path);
      if (responseBytes(response) > MAX_RESPONSE_BYTES) {
        failWorker(state, "directory-reader-response-limit", job.path);
        return;
      }
      finishJob(job, response);
    } catch (error: unknown) {
      const code = error instanceof IsolatedDirectoryReaderError ? error.code : "directory-reader-protocol";
      failWorker(state, code, job.path);
    }
  }

  function startWorker(): WorkerState {
    const child = spawnProcess(executablePath, [scriptPath], {
      env: { ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcess;
    if (!child.stdin || !child.stdout || !child.stderr) {
      let closeProcess!: () => void;
      const closed = new Promise<void>((resolvePromise) => (closeProcess = resolvePromise));
      reaping = closed;
      child.once("close", () => {
        closeProcess();
        if (reaping === closed) reaping = undefined;
      });
      try {
        child.kill("SIGKILL");
      } catch {
        // The close event remains the authority for process reaping.
      }
      throw new Error("Directory reader process streams are unavailable.");
    }
    let close!: () => void;
    const state: WorkerState = {
      child: child as ChildProcessWithoutNullStreams,
      closed: new Promise<void>((resolvePromise) => (close = resolvePromise)),
      close: () => close(),
      buffer: "",
      failed: false,
    };
    worker = state;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (worker !== state || state.failed) return;
      state.buffer += chunk;
      let newline = state.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = state.buffer.slice(0, newline);
        state.buffer = state.buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") + 1 > MAX_RESPONSE_BYTES) {
          failWorker(state, "directory-reader-response-limit", [...active.values()][0]?.path);
          return;
        }
        receiveLine(state, line);
        if (state.failed) return;
        newline = state.buffer.indexOf("\n");
      }
      if (Buffer.byteLength(state.buffer, "utf8") > MAX_RESPONSE_BYTES)
        failWorker(state, "directory-reader-response-limit", [...active.values()][0]?.path);
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => failWorker(state, "directory-reader-crashed"));
    child.on("close", () => {
      state.close();
      if (worker === state) worker = undefined;
      if (reaping === state.closed) reaping = undefined;
      if (!state.failed && (active.size > 0 || queue.length > 0)) {
        state.failed = true;
        cooldownUntil = Math.max(cooldownUntil, now() + FAILURE_COOLDOWN_MS);
        rejectJobs((path) => serviceError("directory-reader-crashed", path));
      }
    });
    child.stdout.on("error", () => failWorker(state, "directory-reader-crashed"));
    child.stdin.on("error", () => failWorker(state, "directory-reader-crashed"));
    return state;
  }

  const readDirectory = (path: string): Promise<readonly DirectoryEntry[]> => {
    if (disposed) return Promise.reject(serviceError("directory-reader-disposed", path));
    if (typeof path !== "string" || !path || path.includes("\0") || !isAbsolute(path))
      return Promise.reject(serviceError("directory-reader-invalid-request", String(path)));
    const canonicalInput = resolve(path);
    if (now() < cooldownUntil || reaping)
      return Promise.reject(serviceError("directory-reader-cooldown", canonicalInput));
    const existing = inFlightByPath.get(canonicalInput);
    if (existing) return existing;
    if (queue.length >= MAX_QUEUE) return Promise.reject(serviceError("directory-reader-busy", canonicalInput));
    let resolveJob!: (entries: readonly DirectoryEntry[]) => void;
    let rejectJob!: (error: Error) => void;
    const promise = new Promise<readonly DirectoryEntry[]>((resolvePromise, reject) => {
      resolveJob = resolvePromise;
      rejectJob = reject;
    });
    const job: Job = { id: randomUUID(), path: canonicalInput, resolve: resolveJob, reject: rejectJob };
    inFlightByPath.set(canonicalInput, promise);
    queue.push(job);
    dispatchQueued();
    return promise;
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    rejectJobs((path) => serviceError("directory-reader-disposed", path));
    const state = worker;
    if (!state) {
      await reaping;
      return;
    }
    reaping = state.closed;
    try {
      state.child.kill("SIGKILL");
    } catch {
      // Wait for close below even if kill reports that the process already exited.
    }
    await state.closed;
    if (worker === state) worker = undefined;
    if (reaping === state.closed) reaping = undefined;
  };

  return { readDirectory, dispose };
}

let sharedReader: IsolatedDirectoryReader | undefined;

export function getSharedIsolatedDirectoryReader(): IsolatedDirectoryReader {
  sharedReader ??= createIsolatedDirectoryReader();
  return sharedReader;
}

export async function disposeSharedIsolatedDirectoryReader(): Promise<void> {
  await sharedReader?.dispose();
}
