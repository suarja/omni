import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildIdentity } from "./runtime-identity";

export const USER_MCP_RUNTIME_RELATIVE_PATH = join("omni", "mcp", "omni-mcp.mjs");
export const DESKTOP_MANIFEST_RELATIVE_PATH = join("omni", "desktop.json");

export type EnsureOmniMcpRuntimeOptions = Readonly<{
  userDataPath: string;
  sourcePath: string;
}>;

export type DesktopManifestOptions = Readonly<{
  userDataPath: string;
  version: string;
  runtimePath?: string;
  startedAt?: string;
  build?: BuildIdentity;
  profilePath?: string;
  appPath?: string;
}>;

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function userMcpRuntimePath(userDataPath: string): string {
  return join(userDataPath, USER_MCP_RUNTIME_RELATIVE_PATH);
}

export function desktopManifestPath(userDataPath: string): string {
  return join(userDataPath, DESKTOP_MANIFEST_RELATIVE_PATH);
}

async function writeAtomically(path: string, content: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.omni-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function ensureOmniMcpRuntime(options: EnsureOmniMcpRuntimeOptions): Promise<string | undefined> {
  if (!(await readable(options.sourcePath))) return undefined;
  const target = userMcpRuntimePath(options.userDataPath);
  const targetDirectory = dirname(target);
  await mkdir(targetDirectory, { recursive: true });
  const source = await readFile(options.sourcePath);
  let temporary: string | undefined;
  try {
    if ((await readFile(target).catch(() => undefined))?.equals(source)) return target;
    temporary = join(targetDirectory, `.omni-mcp-${process.pid}-${Date.now()}.tmp`);
    await copyFile(options.sourcePath, temporary);
    await rename(temporary, target);
    return target;
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}

export async function writeDesktopManifest(options: DesktopManifestOptions): Promise<string> {
  const path = desktopManifestPath(options.userDataPath);
  await mkdir(dirname(path), { recursive: true });
  const content = Buffer.from(
    `${JSON.stringify({
      name: "Omni",
      version: options.version,
      ...(options.build ? { build: options.build } : {}),
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      ...(options.appPath ? { appPath: options.appPath } : {}),
      ...(options.runtimePath ? { runtimePath: options.runtimePath } : {}),
      startedAt: options.startedAt ?? new Date().toISOString(),
    })}\n`,
  );
  await writeAtomically(path, content);
  return path;
}
