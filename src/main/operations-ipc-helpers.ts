import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { app, dialog, ipcMain } from "electron";

import { projectPluginManifest } from "../domain/harness-projection";
import { createMarketplaceManifest, createPackageManifest, slugify } from "../domain/marketplace-format";
import { hashContent } from "./marketplace-manifests";
import { isMissing } from "./fs-optional";
import type { RegistryIpcServices } from "./registry-ipc";
import { createOperationStore, type OperationStore } from "./operation-store";
import { systemGitCli, type GitCli } from "./git-cli";
import { createImportOperations } from "./operations-import";
import { createCompatibleOperations } from "./operations-compatible";
import { operationPaths } from "./operations-paths";
import { createRestoreOperations } from "./operations-restore";
import { createSettingsStore, settingsFilePath, type SettingsStore } from "./settings-store";
import {
  OPERATIONS_IPC_CHANNELS,
  parseApplyOperationRequest,
  parseEmptyOperationsRequest,
  parsePreviewMarketplaceRequest,
  parsePreviewOperationRequest,
  type OperationAction,
  type OperationActionReceipt,
  type OperationPlan,
  type OperationReceipt,
  type PreviewMarketplaceRequest,
  type PreviewMarketplaceResponse,
} from "../shared/operations-ipc";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type Clock = () => number;
type DirectoryPicker = Readonly<{
  showOpenDialog(options: {
    properties: readonly ["openDirectory"];
  }): Promise<{ canceled: boolean; filePaths: readonly string[] }>;
}>;
type FileWriter = (
  path: string,
  content: string | Uint8Array,
  options: { encoding: "utf8"; mode: number },
) => Promise<void>;
type ParentGrant = Readonly<{ path: string; expiresAt: number }>;
type PlannedAction = OperationAction & Readonly<{ absolutePath: string; content?: string }>;
type StoredPlan = Readonly<{
  plan: OperationPlan;
  parentPath: string;
  targetPath: string;
  actions: readonly PlannedAction[];
  name: string;
}>;

type OperationsIpcOptions = Readonly<{
  now?: Clock;
  ttlMs?: number;
  userDataPath?: string;
  directoryPicker?: DirectoryPicker;
  operationStore?: OperationStore;
  gitCli?: GitCli;
  fileWriter?: FileWriter;
  settingsStore?: SettingsStore;
}>;

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const SAFE_GIT_WARNING = "Git metadata will not be written outside the created marketplace.";

export function isWithin(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance));
}

export function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "Marketplace operation failed safely.";
  return message.length <= 240 && !/[\r\n]/.test(message) && !/(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(message)
    ? message
    : "Marketplace operation failed safely.";
}

export function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : basename(path) || "<root>";
}

export async function currentDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("Selected parent is not a directory.");
  return canonical;
}

export function invalidName(name: string): boolean {
  const normalized = name.trim().replaceAll("\\", "/");
  return (
    normalized === "" ||
    normalized.includes("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === ".") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(name)
  );
}

export async function targetState(path: string): Promise<"absent" | "empty" | "non-empty"> {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) return "non-empty";
    return (await readdir(path)).length === 0 ? "empty" : "non-empty";
  } catch (error: unknown) {
    if (isMissing(error)) return "absent";
    throw error;
  }
}

export function contentFor(
  request: PreviewMarketplaceRequest,
  now: number,
  slug: string,
): {
  marketplace: string;
  package: string;
  claudeMarketplace: string;
  codexMarketplace: string;
  claudePlugin: string;
  codexPlugin: string;
} {
  const createdAt = new Date(now).toISOString();
  const packageManifest = createPackageManifest({ id: slug, name: request.name.trim() });
  return {
    marketplace: `${JSON.stringify(createMarketplaceManifest({ name: request.name.trim(), createdAt, id: slug }), null, 2)}\n`,
    package: `${JSON.stringify(packageManifest, null, 2)}\n`,
    claudeMarketplace: `${JSON.stringify({ name: request.name.trim(), plugins: [] }, null, 2)}\n`,
    codexMarketplace: `${JSON.stringify({ name: request.name.trim(), plugins: [] }, null, 2)}\n`,
    claudePlugin: `${JSON.stringify(projectPluginManifest(packageManifest, "claude-code"), null, 2)}\n`,
    codexPlugin: `${JSON.stringify(projectPluginManifest(packageManifest, "codex"), null, 2)}\n`,
  };
}

export function failedReceipt(
  plan: OperationPlan,
  now: number,
  actions: readonly OperationActionReceipt[] = [],
): OperationReceipt {
  return {
    operationId: randomUUID(),
    kind: plan.kind,
    status: "failed",
    appliedAt: new Date(now).toISOString(),
    displayTarget: plan.displayTarget,
    actions,
    git: { mode: plan.git.mode },
    registered: null,
  };
}

export async function rollback(
  createdFiles: readonly string[],
  createdDirectories: readonly string[],
  gitDirectory: string,
): Promise<void> {
  await Promise.all(
    [...createdFiles, ...(gitDirectory ? [gitDirectory] : [])].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  for (const path of [...createdDirectories].reverse()) await rm(path, { recursive: true, force: true });
}
