import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { app, ipcMain } from "electron";

import { createLocalInventoryPort } from "../adapters/inventory/local-filesystem";
import { detectStack, type DetectStackInput, type ManifestInput, type StackProfile } from "../domain/stack-profile";
import { MANIFEST_BASENAMES } from "../domain/stack-tags";
import type { InventoryFilesystemPort } from "../ports/inventory";
import {
  STACK_PROFILE_IPC_CHANNELS,
  parseStackProfile,
  parseStackProfileRequest,
  type StackProfileRequest,
  type StackProfileResponse,
} from "../shared/stack-profile-ipc";
import { grantFor } from "./assignment-resolution";
import { currentGrantRoot, resolveGrantedPath } from "./granted-hashing";
import type { RegistryGrant, RegistryGrantStore, RegistryIpcServices } from "./registry-ipc";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;

/**
 * `omni:projects:stack-profile` (read-only, level 0 — no model, no network): resolves the
 * project's grant, walks its granted root through the inventory port with the bounds below,
 * and hands what it read to `detectStack`. Every content read goes through
 * `InventoryFilesystemPort.readText`; file metadata for the cache key comes from a raw `stat`
 * under the same grant (`granted-hashing.ts`), since the port does not expose mtimes.
 */

// Build outputs, dependencies, and folders that hold other people's code (vendored copies,
// examples, fixtures, documentation archives): their manifests never describe this project.
const SKIP_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".expo",
  "coverage",
  "vendor",
  "third_party",
  "target",
  "Pods",
  "DerivedData",
  "docs",
  "archive",
  "examples",
  "example",
  "fixtures",
  "__fixtures__",
]);
const HARNESS_HIDDEN_ALLOW = new Set([".claude", ".codex", ".cursor", ".github"]);
const HARNESS_MARKERS = new Set(["CLAUDE.md", "AGENTS.md", ".claude", ".codex", ".cursor"]);
const MAX_DEPTH = 4;
const MAX_MANIFEST_FILES = 64;
const MAX_MANIFEST_BYTES = 256 * 1024;

type WalkAccumulator = {
  presentPaths: string[];
  extensionCounts: Record<string, number>;
  harnessFiles: string[];
  manifestPaths: string[];
};

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

function joinRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

/** Depth-bounded, skip-listed walk. Never throws: an unreadable subtree is treated as empty. */
async function walk(filesystem: InventoryFilesystemPort, path: string, acc: WalkAccumulator): Promise<void> {
  let entries;
  try {
    entries = await filesystem.listDirectory(path);
  } catch {
    return;
  }
  // A nested repository (a Git submodule or a vendored checkout under docs/, archive/, …) is
  // another project: its manifests would describe that project's stack, not this one's.
  if (path && entries.some((entry) => entry.name === ".git")) return;
  for (const entry of entries) {
    if (entry.name.startsWith(".") && !HARNESS_HIDDEN_ALLOW.has(entry.name)) continue;
    if (SKIP_NAMES.has(entry.name)) continue;
    const entryPath = joinRelativePath(path, entry.name);
    acc.presentPaths.push(entryPath);
    if (HARNESS_MARKERS.has(entry.name)) acc.harnessFiles.push(entry.name);
    if (entry.type === "directory") {
      if (entryPath.split("/").length <= MAX_DEPTH) await walk(filesystem, entryPath, acc);
      continue;
    }
    if (entry.type === "file") {
      const extension = extensionOf(entry.name);
      if (extension) acc.extensionCounts[extension] = (acc.extensionCounts[extension] ?? 0) + 1;
      if (acc.manifestPaths.length < MAX_MANIFEST_FILES && MANIFEST_BASENAMES.has(entry.name)) {
        acc.manifestPaths.push(entryPath);
      }
    }
  }
}

/**
 * The cache key: sha256 over the sorted `(relative path, size, mtime)` of the manifest files the
 * walk found — cheap (metadata only, no content read) so a request can decide whether to recompute
 * before it reads a single byte of manifest content.
 */
async function manifestTreeHash(grant: RegistryGrant, manifestPaths: readonly string[]): Promise<string | undefined> {
  const lines: string[] = [];
  for (const path of [...manifestPaths].sort()) {
    const location = await resolveGrantedPath(grant, path);
    if (location === "denied") return undefined;
    if (location === "unavailable") continue;
    const details = await stat(location).catch(() => undefined);
    if (!details) continue;
    lines.push(`${path}|${details.size}|${details.mtimeMs}`);
  }
  return createHash("sha256").update(lines.sort().join("\n"), "utf8").digest("hex");
}

async function readManifests(
  filesystem: InventoryFilesystemPort,
  manifestPaths: readonly string[],
): Promise<ManifestInput[]> {
  const manifests: ManifestInput[] = [];
  for (const path of manifestPaths) {
    try {
      manifests.push({ path, content: await filesystem.readText(path) });
    } catch {
      // Oversized, binary, or unreadable manifests are skipped: the tags they would have proven
      // simply carry less evidence, and the request never fails for one bad file.
    }
  }
  return manifests;
}

export type StackProfileStore = Readonly<{
  get(projectId: string): Promise<StackProfile | undefined>;
  set(projectId: string, profile: StackProfile): Promise<void>;
}>;

export function stackProfileStoreFilePath(userDataPath: string): string {
  return join(resolve(userDataPath), "omni", "stack-profiles.json");
}

function parseStoredProfiles(value: unknown): Record<string, StackProfile> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, StackProfile> = {};
  for (const [projectId, candidate] of Object.entries(value as Record<string, unknown>)) {
    try {
      result[projectId] = parseStackProfile(candidate);
    } catch {
      // A corrupt entry for one project never blocks the others; it is simply recomputed.
    }
  }
  return result;
}

async function writeProfilesAtomically(filePath: string, data: Readonly<Record<string, StackProfile>>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function createStackProfileStore(filePath: string): StackProfileStore {
  let queue = Promise.resolve();
  const read = async (): Promise<Record<string, StackProfile>> => {
    try {
      return parseStoredProfiles(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    } catch {
      return {};
    }
  };
  return {
    async get(projectId) {
      const all = await read();
      return all[projectId];
    },
    async set(projectId, profile) {
      const result = queue.then(async () => {
        const all = await read();
        await writeProfilesAtomically(filePath, { ...all, [projectId]: profile });
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

async function resolveStackProfile(
  request: StackProfileRequest,
  grants: RegistryGrantStore,
  store: StackProfileStore,
  now: () => string,
): Promise<StackProfileResponse> {
  const grant = grantFor(grants, { kind: "project", id: request.projectId }, request.grantHandle);
  if (!grant || !(await currentGrantRoot(grant))) return { status: "denied" };

  const filesystem = createLocalInventoryPort(grant.root, { maxDepth: MAX_DEPTH, maxFileBytes: MAX_MANIFEST_BYTES });
  const acc: WalkAccumulator = { presentPaths: [], extensionCounts: {}, harnessFiles: [], manifestPaths: [] };
  try {
    await walk(filesystem, "", acc);
  } catch {
    return { status: "unavailable", reason: "The project tree could not be observed." };
  }

  const treeHash = await manifestTreeHash(grant, acc.manifestPaths);
  if (treeHash === undefined) return { status: "denied" };

  const cached = request.refresh ? undefined : await store.get(request.projectId).catch(() => undefined);
  if (cached && cached.treeHash === treeHash) return { status: "ready", profile: cached, cached: true };

  const manifests = await readManifests(filesystem, acc.manifestPaths);
  const input: DetectStackInput = {
    manifests,
    presentPaths: acc.presentPaths,
    extensionCounts: acc.extensionCounts,
    harnessFiles: acc.harnessFiles,
    computedAt: now(),
    treeHash,
  };
  const profile = detectStack(input);
  await store.set(request.projectId, profile).catch(() => undefined);
  return { status: "ready", profile, cached: false };
}

export type GetStackProfileOptions = Readonly<{ refresh?: boolean; now?: () => string }>;

/**
 * The same computation `omni:projects:stack-profile` performs, usable directly from trusted
 * main-process code (the agent gateway's `stack_profile` method) without a renderer-issued grant
 * handle: resolves the project's own grant from the registry, then walks and caches exactly as
 * the IPC handler does. Denied exactly as the IPC handler would when the project has no grant.
 */
export async function getStackProfile(
  projectId: string,
  registry: RegistryIpcServices,
  store: StackProfileStore,
  options: GetStackProfileOptions = {},
): Promise<StackProfileResponse> {
  const grantHandle = await registry.getGrantForEntry({ kind: "project", id: projectId });
  if (!grantHandle) return { status: "denied" };
  return resolveStackProfile(
    { projectId, grantHandle, ...(options.refresh === undefined ? {} : { refresh: options.refresh }) },
    registry,
    store,
    options.now ?? (() => new Date().toISOString()),
  );
}

export type StackProfileIpcOptions = Readonly<{
  userDataPath?: string;
  store?: StackProfileStore;
  now?: () => string;
}>;

export function registerStackProfileIpcHandlers(
  assertTrustedSender: SenderGuard,
  grants: RegistryGrantStore,
  options: StackProfileIpcOptions = {},
): void {
  const userDataPath = options.userDataPath ?? app.getPath("userData");
  const store = options.store ?? createStackProfileStore(stackProfileStoreFilePath(userDataPath));
  const now = options.now ?? (() => new Date().toISOString());
  ipcMain.handle(STACK_PROFILE_IPC_CHANNELS.get, async (event, rawRequest: unknown) => {
    assertTrustedSender(event);
    try {
      return await resolveStackProfile(parseStackProfileRequest(rawRequest), grants, store, now);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Stack profile request failed safely.";
      throw new Error(
        message.length <= 240 && !/[\r\n]/.test(message) ? message : "Stack profile request failed safely.",
      );
    }
  });
}
