import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { Binding } from "../domain/assignment-plan";
import { parseBinding, parseBindingsListResponse, type BindingsListResponse } from "../shared/bindings-ipc";

export type BindingsStoreResult = BindingsListResponse;
export type ExactBindingEffect = Readonly<{ bindingId: string; expected?: Binding; next?: Binding }>;
export interface BindingsStore {
  read(): Promise<BindingsStoreResult>;
  save(bindings: readonly Binding[]): Promise<BindingsStoreResult>;
  remove(bindingId: string): Promise<BindingsStoreResult>;
  updateExact(effects: readonly ExactBindingEffect[]): Promise<BindingsStoreResult>;
}

type BindingsState = Readonly<{ schemaVersion: 1; bindings: readonly Binding[] }>;
const storesByPath = new Map<string, BindingsStore>();
class BindingsPathError extends Error {}

function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}
function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function pathStatus(filePath: string, label: string): Promise<"absent" | "present"> {
  try {
    const details = await lstat(filePath);
    if (details.isSymbolicLink()) throw new BindingsPathError(`${label} must not be a symbolic link.`);
    if (!details.isFile()) throw new BindingsPathError(`${label} must be a regular file.`);
    return "present";
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return "absent";
    throw error;
  }
}

function parseState(value: unknown): BindingsState {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Bindings state is invalid.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "bindings"].includes(key)))
    throw new Error("Bindings state contains an unknown field.");
  if (record.schemaVersion !== 1) throw new Error("Bindings schema is unsupported.");
  const parsed = parseBindingsListResponse({ status: "ready", bindings: record.bindings });
  if (parsed.status !== "ready") throw new Error("Bindings state is corrupt.");
  return { schemaVersion: 1, bindings: parsed.bindings };
}

function diagnostic(error: unknown): string {
  if (error instanceof BindingsPathError) return error.message;
  if (error instanceof SyntaxError) return "Bindings JSON is invalid.";
  return "Bindings store could not be read safely.";
}

async function parseFile(filePath: string): Promise<BindingsState> {
  return parseState(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

async function hasValidBackup(filePath: string): Promise<boolean> {
  try {
    if ((await pathStatus(backupPath(filePath), "Bindings backup")) === "absent") return false;
    await parseFile(backupPath(filePath));
    return true;
  } catch {
    return false;
  }
}

async function load(filePath: string): Promise<BindingsStoreResult> {
  try {
    const main = await pathStatus(filePath, "Bindings file");
    const backup = await pathStatus(backupPath(filePath), "Bindings backup");
    if (main === "absent" && backup === "absent") return { status: "ready", bindings: [] };
    if (main === "absent")
      return {
        status: "corrupt",
        diagnostic: "Bindings file is missing; a valid backup is available.",
        recoveryAvailable: await hasValidBackup(filePath),
      };
    const state = await parseFile(filePath);
    await chmod(filePath, 0o600);
    return { status: "ready", bindings: state.bindings };
  } catch (error: unknown) {
    return { status: "corrupt", diagnostic: diagnostic(error), recoveryAvailable: await hasValidBackup(filePath) };
  }
}

async function writeAtomically(filePath: string, state: BindingsState): Promise<void> {
  await pathStatus(filePath, "Bindings target");
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

function sameUnit(left: Binding, right: Binding): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.packageId === right.packageId &&
    left.artifactPath === right.artifactPath &&
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    left.harnessId === right.harnessId
  );
}

export function bindingsFilePath(userDataPath: string): string {
  return join(userDataPath, "omni", "bindings.json");
}

export function createBindingsStore(filePath: string): BindingsStore {
  const resolvedFilePath = resolve(filePath);
  const existing = storesByPath.get(resolvedFilePath);
  if (existing) return existing;
  let loaded: BindingsStoreResult | undefined;
  let loadPromise: Promise<BindingsStoreResult> | undefined;
  let writeQueue = Promise.resolve();
  const ensureLoaded = async (): Promise<BindingsStoreResult> => {
    loaded ??= await (loadPromise ??= load(resolvedFilePath));
    return loaded;
  };
  const save = async (incoming: readonly Binding[]): Promise<BindingsStoreResult> => {
    const result = writeQueue.then(async () => {
      const current = await ensureLoaded();
      if (current.status === "corrupt") return current;
      const validated = incoming.map(parseBinding);
      let nextBindings = [...current.bindings];
      for (const binding of validated) {
        const index = nextBindings.findIndex((candidate) => sameUnit(candidate, binding));
        if (index === -1) nextBindings.push(binding);
        else nextBindings[index] = binding;
      }
      const next: BindingsState = { schemaVersion: 1, bindings: nextBindings };
      await pathStatus(resolvedFilePath, "Bindings file");
      await pathStatus(backupPath(resolvedFilePath), "Bindings backup");
      await writeAtomically(backupPath(resolvedFilePath), next);
      await writeAtomically(resolvedFilePath, next);
      loaded = { status: "ready", bindings: next.bindings };
      return loaded;
    });
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const remove = async (bindingId: string): Promise<BindingsStoreResult> => {
    const result = writeQueue.then(async () => {
      const current = await ensureLoaded();
      if (current.status === "corrupt") return current;
      const nextBindings = current.bindings.filter((binding) => binding.bindingId !== bindingId);
      if (nextBindings.length === current.bindings.length) return current;
      const next: BindingsState = { schemaVersion: 1, bindings: nextBindings };
      await pathStatus(resolvedFilePath, "Bindings file");
      await pathStatus(backupPath(resolvedFilePath), "Bindings backup");
      await writeAtomically(backupPath(resolvedFilePath), next);
      await writeAtomically(resolvedFilePath, next);
      loaded = { status: "ready", bindings: next.bindings };
      return loaded;
    });
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const updateExact = async (effects: readonly ExactBindingEffect[]): Promise<BindingsStoreResult> => {
    const result = writeQueue.then(async () => {
      const current = await ensureLoaded();
      if (current.status === "corrupt") return current;
      if (new Set(effects.map((effect) => effect.bindingId)).size !== effects.length)
        throw new Error("Binding effects are duplicated.");
      const validated = effects.map((effect) => ({
        bindingId: effect.bindingId,
        ...(effect.expected ? { expected: parseBinding(effect.expected) } : {}),
        ...(effect.next ? { next: parseBinding(effect.next) } : {}),
      }));
      if (
        validated.some(
          (effect) => effect.expected?.bindingId !== undefined && effect.expected.bindingId !== effect.bindingId,
        )
      )
        throw new Error("Binding effect identity is invalid.");
      if (
        validated.some((effect) => effect.next?.bindingId !== undefined && effect.next.bindingId !== effect.bindingId)
      )
        throw new Error("Binding effect identity is invalid.");
      if (validated.some((effect) => !effect.expected && !effect.next)) throw new Error("Binding effect is empty.");
      for (const effect of validated) {
        const existing = current.bindings.find((binding) => binding.bindingId === effect.bindingId);
        if (JSON.stringify(existing) !== JSON.stringify(effect.expected))
          throw new Error("A binding changed after the operation was prepared.");
      }
      const affected = new Set(validated.map((effect) => effect.bindingId));
      const nextBindings = [
        ...current.bindings.filter((binding) => !affected.has(binding.bindingId)),
        ...validated.flatMap((effect) => (effect.next ? [effect.next] : [])),
      ];
      if (new Set(nextBindings.map((binding) => binding.bindingId)).size !== nextBindings.length)
        throw new Error("Binding ids would collide.");
      for (let index = 0; index < nextBindings.length; index += 1) {
        if (nextBindings.slice(index + 1).some((candidate) => sameUnit(nextBindings[index]!, candidate)))
          throw new Error("Binding units would collide.");
      }
      const next: BindingsState = { schemaVersion: 1, bindings: nextBindings };
      await pathStatus(resolvedFilePath, "Bindings file");
      await pathStatus(backupPath(resolvedFilePath), "Bindings backup");
      await writeAtomically(backupPath(resolvedFilePath), next);
      await writeAtomically(resolvedFilePath, next);
      loaded = { status: "ready", bindings: next.bindings };
      return loaded;
    });
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const store: BindingsStore = { read: ensureLoaded, save, remove, updateExact };
  storesByPath.set(resolvedFilePath, store);
  return store;
}
