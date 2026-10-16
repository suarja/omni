import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { app, ipcMain } from "electron";

import type { Binding } from "../domain/assignment-plan";
import { createUnifiedDiff } from "../domain/unified-diff";
import { resolveTarget } from "../domain/harness-targets";
import { createLocalJsonRegistryStore } from "../adapters/registry/local-json";
import type {
  ApplyBlockedResponse,
  ApplyPreviewRequest,
  ApplyRunRequest,
  ApplyRunResponse,
  RemovePreviewAction,
  RemovePreviewRequest,
  RemovePreviewResponse,
  RemoveRunRequest,
  RestorePreviewResponse,
} from "../shared/apply-ipc";
import {
  APPLY_IPC_CHANNELS,
  parseApplyPreviewRequest,
  parseApplyRunRequest,
  parseRemovePreviewRequest,
  parseRemoveRunRequest,
  parseRestorePreviewRequest,
  parseRestoreRunRequest,
  type RestoreRunRequest,
} from "../shared/apply-ipc";
import type { RegistryState } from "../domain/project-source-registry";
import type { SettingsStore } from "./settings-store";
import { createSettingsStore, settingsFilePath } from "./settings-store";
import type { RegistryGrant, RegistryGrantStore } from "./registry-ipc";
import { currentGrantRoot, hashGrantedPath, resolveGrantedPath } from "./granted-hashing";
import {
  activeRegistration,
  grantFor,
  observeTarget,
  resolveUnitFromGrant,
  resolveUnitFromRoot,
  type ResolvedUnit,
} from "./assignment-resolution";
import {
  backupFiles,
  listRegularFiles,
  removeFileOrEmptyDirectories,
  restoreBackup,
  type FileWriter,
} from "./operation-files";
import { bindingsFilePath, createBindingsStore, type BindingsStore } from "./bindings-store";
import { createOperationStore, type OperationStore } from "./operation-store";
import { systemGitCli, type GitCli } from "./git-cli";
import {
  assignmentCommitMessage,
  buildApplyPlan,
  executeApply,
  type ApplyEngineOptions,
  type ApplyPlan,
} from "./apply-engine";
import type { OperationReceipt } from "../shared/operations-ipc";

export type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
export type Clock = () => number;
export type ApplyIpcOptions = Readonly<{
  userDataPath?: string;
  bindingsStore?: BindingsStore;
  operationStore?: OperationStore;
  settingsStore?: SettingsStore;
  gitCli?: GitCli;
  fileWriter?: FileWriter;
  now?: Clock;
  ttlMs?: number;
}>;
export type StoredApply = Readonly<{ plan: ApplyPlan; request: ApplyPreviewRequest; expiresAt: number }>;
export type RemoveFile = Readonly<{ relativePath: string; contentHash: string; modified: boolean }>;
export class RemoveTargetError extends Error {
  constructor(readonly relativePath: string) {
    super(`Cannot safely inspect managed target file: ${relativePath}`);
  }
}
export type StoredRemove = Readonly<{
  planId: string;
  binding: Binding;
  projectRoot: string;
  projectGrant: RegistryGrant;
  targetPath: string;
  unitId: string;
  harnessId: Binding["harnessId"];
  files: readonly RemoveFile[];
  targetSnapshot?: string;
  targetMissing?: true;
  expiresAt: number;
  settings: Awaited<ReturnType<SettingsStore["read"]>>;
  projectName: string;
}>;
export type StoredRestore = Readonly<{
  planId: string;
  receipt: OperationReceipt;
  projectRoot: string;
  projectName: string;
  settings: Awaited<ReturnType<SettingsStore["read"]>>;
  expiresAt: number;
}>;

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Apply request failed safely.";
  return message.length <= 240 && !/[\r\n]/.test(message) && !/(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(message)
    ? message
    : "Apply request failed safely.";
}

export async function registryState(userDataPath: string): Promise<RegistryState> {
  const result = await createLocalJsonRegistryStore(join(userDataPath, "omni/project-source-registry.json")).read();
  if (result.status === "corrupt") throw new Error("Registry is unavailable.");
  return result.state;
}

export async function internalGrant(root: string): Promise<RegistryGrant> {
  const canonical = await realpath(root);
  const details = await stat(canonical);
  return {
    handle: "internal-restore",
    subject: { kind: "project", id: "internal" },
    root: canonical,
    device: String(details.dev),
    inode: String(details.ino),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

export function expired(expiresAt: number, now: Clock): boolean {
  return expiresAt <= now();
}

export function blocked(reason: string, diagnostic?: string): ApplyBlockedResponse {
  return { status: "blocked", reason, ...(diagnostic ? { diagnostic } : {}) };
}

export function harnessName(harnessId: Binding["harnessId"]): string {
  return harnessId === "claude-code" ? "Claude Code" : harnessId === "codex" ? "Codex" : "Cursor";
}

export function harnessesFromPaths(paths: readonly string[]): readonly string[] {
  const names: string[] = [];
  for (const path of paths) {
    const name =
      path === "CLAUDE.md" || path.startsWith(".claude/")
        ? "Claude Code"
        : path === "AGENTS.md" || path.startsWith(".agents/")
          ? "Codex"
          : path.startsWith(".cursor/")
            ? "Cursor"
            : undefined;
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

export function engineOptions(
  userDataPath: string,
  bindingsStore: BindingsStore,
  operationStore: OperationStore,
  settings: Awaited<ReturnType<SettingsStore["read"]>>,
  git: GitCli,
  fileWriter: FileWriter | undefined,
  now: Clock,
): ApplyEngineOptions {
  return { userDataPath, bindingsStore, operationStore, settings, git, ...(fileWriter ? { fileWriter } : {}), now };
}

export function targetFile(targetPath: string, unitFilePath: string): string {
  return unitFilePath ? `${targetPath}/${unitFilePath}` : targetPath;
}

export function boundedDiff(text: string): Readonly<{ kind: "unified"; text: string; truncated: boolean }> {
  if (Buffer.byteLength(text, "utf8") <= 64 * 1024) return { kind: "unified", text, truncated: false };
  let bounded = text;
  while (bounded && Buffer.byteLength(bounded, "utf8") > 64 * 1024) bounded = bounded.slice(0, -1);
  return { kind: "unified", text: bounded, truncated: true };
}

export async function currentTargetFiles(
  grant: RegistryGrant,
  targetPath: string,
  linked: boolean,
  isFolder: boolean,
): Promise<readonly string[]> {
  if (linked) return [];
  if (isFolder) return listRegularFiles(grant.root, targetPath);
  const target = await resolveGrantedPath(grant, targetPath);
  return target === "denied" || target === "unavailable" ? [] : [targetPath];
}

export async function removalFiles(
  grant: RegistryGrant,
  targetPath: string,
  linked: boolean,
  unit: ResolvedUnit,
): Promise<readonly RemoveFile[]> {
  const unitFiles = unit.unit.files ?? [{ relativePath: "", contentHash: unit.unit.contentHash }];
  const files = await currentTargetFiles(
    grant,
    targetPath,
    linked,
    unitFiles.length > 1 || unitFiles.some((file) => file.relativePath !== ""),
  );
  const result: RemoveFile[] = [];
  for (const relativePath of files) {
    const current = await hashGrantedPath(grant, relativePath);
    if (current.status !== "hashed") throw new RemoveTargetError(relativePath);
    const unitPath = relativePath === targetPath ? "" : relativePath.slice(`${targetPath}/`.length);
    const marketplace = unitFiles.find((file) => file.relativePath === unitPath);
    const modified = marketplace ? current.contentHash !== marketplace.contentHash : true;
    result.push({ relativePath, contentHash: current.contentHash, modified });
  }
  return result;
}

export async function removalPreviewDiffs(
  projectGrant: RegistryGrant,
  sourceGrant: RegistryGrant,
  targetPath: string,
  files: readonly RemoveFile[],
  unit: ResolvedUnit,
): Promise<readonly RemovePreviewAction[]> {
  const unitFiles = unit.unit.files ?? [{ relativePath: "", contentHash: unit.unit.contentHash }];
  const actions: RemovePreviewAction[] = [];
  for (const file of files) {
    if (!file.modified) {
      const projectPath = await resolveGrantedPath(projectGrant, file.relativePath);
      if (projectPath === "denied" || projectPath === "unavailable") throw new RemoveTargetError(file.relativePath);
      const bytes = await readFile(projectPath);
      const diff = createUnifiedDiff(
        `${file.relativePath} (current)`,
        `${file.relativePath} (deleted)`,
        bytes,
        Buffer.alloc(0),
      );
      actions.push({ ...file, diff: boundedDiff(diff.text) });
      continue;
    }
    const projectPath = await resolveGrantedPath(projectGrant, file.relativePath);
    const projectBytes =
      projectPath === "denied" || projectPath === "unavailable" ? Buffer.alloc(0) : await readFile(projectPath);
    const unitPath = file.relativePath === targetPath ? "" : file.relativePath.slice(`${targetPath}/`.length);
    const sourceFile = unitFiles.find((candidate) => candidate.relativePath === unitPath);
    const sourceRelativePath = sourceFile
      ? `${unit.sourceRelativePath}${sourceFile.relativePath ? `/${sourceFile.relativePath}` : ""}`
      : "";
    const sourceBytes = sourceFile ? await resolveGrantedPath(sourceGrant, sourceRelativePath) : "unavailable";
    const marketplaceBytes =
      sourceBytes === "denied" || sourceBytes === "unavailable" ? Buffer.alloc(0) : await readFile(sourceBytes);
    const diff = createUnifiedDiff(
      `${file.relativePath} (project)`,
      `${file.relativePath} (marketplace)`,
      projectBytes,
      marketplaceBytes,
    ).text;
    actions.push({
      relativePath: file.relativePath,
      contentHash: file.contentHash,
      modified: true,
      diff: boundedDiff(diff),
    });
  }
  return actions;
}

export async function gitMode(
  git: GitCli,
  settings: Awaited<ReturnType<SettingsStore["read"]>>,
  root: string,
): Promise<"commit" | "not-a-repository" | "disabled" | "unavailable"> {
  if (!settings.git.commitChanges) return "disabled";
  if (!(await git.isGitAvailable())) return "unavailable";
  return (await git.isRepositoryRoot(root)) ? "commit" : "not-a-repository";
}

export async function removeStopPath(targetPath: string): Promise<string> {
  return targetPath.split("/").slice(0, 1).join("/");
}
