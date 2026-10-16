import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { parseSkillRelationshipsState } from "../../domain/skill-reconciliation/validation";
import type { ManagedSkillUse, SkillRelationshipsState, SkillUseEffect } from "../../domain/skill-reconciliation/types";
import type { SkillRelationshipStore, SkillRelationshipStoreRead } from "../../ports/skill-reconciliation";

const MAX_STORE_BYTES = 16 * 1024 * 1024;
const EMPTY: SkillRelationshipsState = { schemaVersion: 1, revision: 0, skills: [], uses: [] };
const stores = new Map<string, SkillRelationshipStore>();

function backupPath(path: string): string {
  return `${path}.bak`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("Skill relationship file is unsafe.");
    if (details.size > MAX_STORE_BYTES) throw new Error("Skill relationship file exceeds its size limit.");
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function ensureParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const details = await lstat(parent);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("Skill relationship directory is unsafe.");
}

async function readFileState(path: string): Promise<SkillRelationshipsState> {
  if (!(await fileExists(path))) throw new Error("Skill relationship file is missing.");
  return parseSkillRelationshipsState(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function validBackup(path: string): Promise<boolean> {
  try {
    await readFileState(backupPath(path));
    return true;
  } catch {
    return false;
  }
}

function diagnostic(error: unknown): string {
  if (error instanceof SyntaxError) return "Skill relationship JSON is malformed.";
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return "Skill relationship store access was denied.";
  if (error instanceof Error && /unsafe|size limit|invalid|must|cannot|is not/iu.test(error.message)) {
    return error.message.slice(0, 220);
  }
  return "Skill relationship store could not be read safely.";
}

function locationKey(location: SkillUseEffect["location"]): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sameUse(left: ManagedSkillUse | undefined, right: ManagedSkillUse | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function load(path: string): Promise<SkillRelationshipStoreRead> {
  try {
    const exists = await fileExists(path);
    const backupExists = await fileExists(backupPath(path));
    if (!exists && !backupExists) return { status: "ready", state: EMPTY };
    if (!exists) {
      return {
        status: "corrupt",
        diagnostic: "Skill relationship file is missing; a backup is available.",
        recoveryAvailable: await validBackup(path),
      };
    }
    return { status: "ready", state: await readFileState(path) };
  } catch (error: unknown) {
    return { status: "corrupt", diagnostic: diagnostic(error), recoveryAvailable: await validBackup(path) };
  }
}

async function writeAtomically(path: string, state: SkillRelationshipsState): Promise<void> {
  await ensureParent(path);
  await fileExists(path);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function enqueue<T>(
  tail: Promise<void>,
  operation: () => Promise<T>,
): Readonly<{ result: Promise<T>; next: Promise<void> }> {
  const result = tail.then(operation);
  return {
    result,
    next: result.then(
      () => undefined,
      () => undefined,
    ),
  };
}

export function createSkillRelationshipStore(filePath: string): SkillRelationshipStore {
  const path = resolve(filePath);
  const existing = stores.get(path);
  if (existing) return existing;
  let queue = Promise.resolve();

  const compareAndSave: SkillRelationshipStore["compareAndSave"] = (expectedRevision, skills) => {
    const queued = enqueue(queue, async () => {
      const current = await load(path);
      if (current.status === "corrupt") return current;
      if (current.state.revision !== expectedRevision) {
        return { status: "revision-conflict", actualRevision: current.state.revision } as const;
      }
      const next = parseSkillRelationshipsState({
        schemaVersion: 1,
        revision: current.state.revision + 1,
        skills,
        uses: current.state.uses,
      });
      if (await fileExists(path)) await writeAtomically(backupPath(path), current.state);
      await writeAtomically(path, next);
      return { status: "saved", state: next } as const;
    });
    queue = queued.next;
    return queued.result;
  };

  const updateUsesExact: SkillRelationshipStore["updateUsesExact"] = (expectedRevision, effects, records = []) => {
    const queued = enqueue(queue, async () => {
      const current = await load(path);
      if (current.status === "corrupt") return current;
      if (expectedRevision !== undefined && current.state.revision !== expectedRevision) {
        return { status: "revision-conflict", actualRevision: current.state.revision } as const;
      }
      const touched = new Set<string>();
      const uses = [...current.state.uses];
      const skills = [...current.state.skills];
      const touchedSkills = new Set<string>();
      for (const effect of records) {
        const index = skills.findIndex((skill) => skill.skillId === effect.skillId);
        const actual = index < 0 ? undefined : skills[index];
        if (touchedSkills.has(effect.skillId) || JSON.stringify(actual) !== JSON.stringify(effect.before))
          return { status: "revision-conflict", actualRevision: current.state.revision } as const;
        touchedSkills.add(effect.skillId);
        if (effect.after) {
          if (effect.after.skillId !== effect.skillId) throw new Error("Skill record effect identity is invalid.");
          if (index < 0) skills.push(effect.after);
          else skills[index] = effect.after;
        } else if (index >= 0) skills.splice(index, 1);
      }
      for (const effect of effects) {
        const key = locationKey(effect.location);
        if (touched.has(key)) return { status: "revision-conflict", actualRevision: current.state.revision } as const;
        touched.add(key);
        const index = uses.findIndex((use) => locationKey(use.location) === key);
        const actual = index < 0 ? undefined : uses[index];
        if (!sameUse(actual, effect.before))
          return { status: "revision-conflict", actualRevision: current.state.revision } as const;
        if (effect.after) {
          if (effect.after.skillId !== effect.skillId || locationKey(effect.after.location) !== key) {
            throw new Error("Skill use effect does not match its exact location.");
          }
          if (index < 0) uses.push(effect.after);
          else uses[index] = effect.after;
        } else if (index >= 0) {
          uses.splice(index, 1);
        }
      }
      if (effects.length === 0 && records.length === 0) return { status: "saved", state: current.state } as const;
      const next = parseSkillRelationshipsState({
        schemaVersion: 1,
        revision: current.state.revision + 1,
        skills,
        uses,
      });
      if (await fileExists(path)) await writeAtomically(backupPath(path), current.state);
      await writeAtomically(path, next);
      return { status: "saved", state: next } as const;
    });
    queue = queued.next;
    return queued.result;
  };

  const store: SkillRelationshipStore = { read: () => load(path), compareAndSave, updateUsesExact };
  stores.set(path, store);
  return store;
}
