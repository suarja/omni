// Materializes the guard script into userData (item 1) and writes guard.json (item 5), the same
// way src/main/omni-mcp-runtime.ts does for the MCP runtime and its desktop manifest — a
// deliberate parallel, not a shared abstraction, since the two ship different payloads on
// different schedules (the MCP cli rarely changes; guard.json is rewritten on every registry or
// warn-switch change).
import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

export const USER_GUARD_SCRIPT_RELATIVE_PATH = join("omni", "guard", "omni-guard.mjs");
export const GUARD_CONFIG_RELATIVE_PATH = join("omni", "guard", "guard.json");
export const GUARD_CONFIG_SCHEMA_VERSION = 1;

export type EnsureOmniGuardRuntimeOptions = Readonly<{ userDataPath: string; sourcePath: string }>;
export type GuardConfig = Readonly<{
  schemaVersion: typeof GUARD_CONFIG_SCHEMA_VERSION;
  marketplaceRoots: readonly string[];
  warnProjects: readonly string[];
}>;
export type WriteGuardConfigOptions = Readonly<{
  userDataPath: string;
  marketplaceRoots: readonly string[];
  warnProjects: readonly string[];
}>;

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function userGuardScriptPath(userDataPath: string): string {
  return join(userDataPath, USER_GUARD_SCRIPT_RELATIVE_PATH);
}

export function guardConfigPath(userDataPath: string): string {
  return join(userDataPath, GUARD_CONFIG_RELATIVE_PATH);
}

async function writeAtomically(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.omni-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Copies the shipped guard script into userData, exactly like `ensureOmniMcpRuntime`. */
export async function ensureOmniGuardRuntime(options: EnsureOmniGuardRuntimeOptions): Promise<string | undefined> {
  if (!(await readable(options.sourcePath))) return undefined;
  const target = userGuardScriptPath(options.userDataPath);
  const targetDirectory = dirname(target);
  await mkdir(targetDirectory, { recursive: true });
  const source = await readFile(options.sourcePath);
  let temporary: string | undefined;
  try {
    if ((await readFile(target).catch(() => undefined))?.equals(source)) return target;
    temporary = join(targetDirectory, `.omni-guard-${process.pid}-${Date.now()}.tmp`);
    await copyFile(options.sourcePath, temporary);
    await rename(temporary, target);
    return target;
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}

/** Omni's own data (item 5): rewritten atomically, 0600, never part of any receipt. */
export async function writeGuardConfig(options: WriteGuardConfigOptions): Promise<string> {
  const path = guardConfigPath(options.userDataPath);
  const config: GuardConfig = {
    schemaVersion: GUARD_CONFIG_SCHEMA_VERSION,
    marketplaceRoots: [...new Set(options.marketplaceRoots)].sort(),
    warnProjects: [...new Set(options.warnProjects)].sort(),
  };
  await writeAtomically(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  return path;
}
