import { workshopPushWarnings } from "./workshop-delivery/plan";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { app, dialog } from "electron";

import { hashContent } from "./marketplace-manifests";
import { isMissing } from "./fs-optional";
import type { RegistryIpcServices } from "./registry-ipc";
import { createOperationStore, type OperationStore } from "./operation-store";
import { systemGitCli, type GitCli } from "./git-cli";
import {
  currentDirectory,
  contentFor,
  displayPath,
  failedReceipt,
  invalidName,
  isWithin,
  rollback,
  targetState,
} from "./operations-ipc-helpers";
import { slugify } from "../domain/marketplace-format";
import type {
  ApplyOperationResponse,
  OperationAction,
  OperationActionReceipt,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceRequest,
  PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest, parsePreviewMarketplaceRequest } from "../shared/operations-ipc";

type Clock = () => number;
type DirectoryPicker = Readonly<{
  showOpenDialog(options: { properties: readonly ["openDirectory"] }): Promise<{
    canceled: boolean;
    filePaths: readonly string[];
  }>;
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

type CreateMarketplaceOptions = Readonly<{
  userDataPath?: string;
  ttlMs?: number;
  directoryPicker?: DirectoryPicker;
  operationStore?: OperationStore;
  gitCli?: GitCli;
  fileWriter?: FileWriter;
  now?: Clock;
}>;

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const SAFE_GIT_WARNING = "Git metadata will not be written outside the created marketplace.";

export function createMarketplaceOperations(
  registry: RegistryIpcServices,
  options: CreateMarketplaceOptions = {},
): Readonly<{
  pickParent(): Promise<{ status: "picked"; parentToken: string; displayParent: string } | { status: "cancelled" }>;
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<{ status: "applied" | "failed"; receipt: OperationReceipt }>;
}> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const userDataPath = resolve(options.userDataPath ?? app.getPath("userData"));
  const picker = options.directoryPicker ?? dialog;
  const store = options.operationStore ?? createOperationStore(join(userDataPath, "omni", "operations.json"));
  const git = options.gitCli ?? systemGitCli;
  const write = options.fileWriter ?? (async (path, content, writeOptions) => writeFile(path, content, writeOptions));
  const parents = new Map<string, ParentGrant>();
  const plans = new Map<string, StoredPlan>();

  const prune = (): void => {
    const timestamp = now();
    for (const [token, grant] of parents) if (grant.expiresAt <= timestamp) parents.delete(token);
  };
  const underUserData = async (path: string): Promise<boolean> => {
    const canonicalUserData = await realpath(userDataPath).catch(() => userDataPath);
    return isWithin(canonicalUserData, path);
  };
  const pickParent = async (): Promise<
    { status: "picked"; parentToken: string; displayParent: string } | { status: "cancelled" }
  > => {
    prune();
    const selected = await picker.showOpenDialog({ properties: ["openDirectory"] });
    if (selected.canceled || selected.filePaths.length !== 1) return { status: "cancelled" };
    const path = await currentDirectory(selected.filePaths[0] ?? "");
    const parentToken = randomUUID();
    parents.set(parentToken, { path, expiresAt: now() + ttlMs });
    return { status: "picked", parentToken, displayParent: displayPath(path) };
  };
  const preview = async (rawRequest: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parsePreviewMarketplaceRequest(rawRequest);
    prune();
    if (invalidName(request.name))
      return {
        status: "blocked",
        reason: "invalid-name",
        diagnostic: "Choose a simple marketplace name without path segments.",
      };
    const parent = parents.get(request.parentToken);
    if (!parent) return { status: "blocked", reason: "parent-expired", diagnostic: "Choose the parent folder again." };
    if (await underUserData(parent.path))
      return {
        status: "blocked",
        reason: "parent-inside-user-data",
        diagnostic: "Choose a folder outside Omni user data.",
      };
    const slug = slugify(request.name);
    const targetPath = resolve(parent.path, slug);
    if (!slug || !isWithin(parent.path, targetPath) || targetPath === parent.path)
      return {
        status: "blocked",
        reason: "invalid-name",
        diagnostic: "The marketplace name does not produce a safe folder.",
      };
    if ((await targetState(targetPath)) === "non-empty")
      return { status: "blocked", reason: "target-not-empty", diagnostic: "The target folder already contains files." };
    const gitAvailable = await git.isGitAvailable();
    const enclosing = gitAvailable
      ? await git.enclosingRepository(parent.path)
      : { status: "unavailable" as const, diagnostic: "Git is unavailable." };
    const mode =
      enclosing.status === "repository"
        ? ("enclosing-repository" as const)
        : enclosing.status === "none"
          ? ("init-and-commit" as const)
          : ("unavailable" as const);
    const warnings =
      mode === "enclosing-repository"
        ? [SAFE_GIT_WARNING]
        : mode === "unavailable"
          ? ["Git is unavailable; the marketplace files will still be created."]
          : [];
    const content = contentFor(request, now(), slug);
    const actions: readonly PlannedAction[] = [
      { kind: "create-directory", relativePath: ".", absolutePath: targetPath },
      { kind: "create-directory", relativePath: "packages", absolutePath: join(targetPath, "packages") },
      { kind: "create-directory", relativePath: `packages/${slug}`, absolutePath: join(targetPath, "packages", slug) },
      { kind: "create-directory", relativePath: ".claude-plugin", absolutePath: join(targetPath, ".claude-plugin") },
      { kind: "create-directory", relativePath: ".agents", absolutePath: join(targetPath, ".agents") },
      {
        kind: "create-directory",
        relativePath: ".agents/plugins",
        absolutePath: join(targetPath, ".agents", "plugins"),
      },
      {
        kind: "create-directory",
        relativePath: `packages/${slug}/.claude-plugin`,
        absolutePath: join(targetPath, "packages", slug, ".claude-plugin"),
      },
      {
        kind: "create-directory",
        relativePath: `packages/${slug}/.codex-plugin`,
        absolutePath: join(targetPath, "packages", slug, ".codex-plugin"),
      },
      {
        kind: "write-file",
        relativePath: "omni.marketplace.json",
        byteLength: Buffer.byteLength(content.marketplace),
        absolutePath: join(targetPath, "omni.marketplace.json"),
        content: content.marketplace,
      },
      {
        kind: "write-file",
        relativePath: `packages/${slug}/omni.plugin.json`,
        byteLength: Buffer.byteLength(content.package),
        absolutePath: join(targetPath, "packages", slug, "omni.plugin.json"),
        content: content.package,
      },
      {
        kind: "write-file",
        relativePath: ".claude-plugin/marketplace.json",
        byteLength: Buffer.byteLength(content.claudeMarketplace),
        manifest: true,
        absolutePath: join(targetPath, ".claude-plugin/marketplace.json"),
        content: content.claudeMarketplace,
      },
      {
        kind: "write-file",
        relativePath: ".agents/plugins/marketplace.json",
        byteLength: Buffer.byteLength(content.codexMarketplace),
        manifest: true,
        absolutePath: join(targetPath, ".agents/plugins/marketplace.json"),
        content: content.codexMarketplace,
      },
      {
        kind: "write-file",
        relativePath: `packages/${slug}/.claude-plugin/plugin.json`,
        byteLength: Buffer.byteLength(content.claudePlugin),
        manifest: true,
        absolutePath: join(targetPath, "packages", slug, ".claude-plugin/plugin.json"),
        content: content.claudePlugin,
      },
      {
        kind: "write-file",
        relativePath: `packages/${slug}/.codex-plugin/plugin.json`,
        byteLength: Buffer.byteLength(content.codexPlugin),
        manifest: true,
        absolutePath: join(targetPath, "packages", slug, ".codex-plugin/plugin.json"),
        content: content.codexPlugin,
      },
    ];
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "create-marketplace",
      displayTarget: slug,
      actions: actions.map(({ absolutePath: _absolutePath, content: _content, ...action }) => action),
      git: { mode, warnings: workshopPushWarnings(mode, warnings) },
    };
    plans.set(plan.planId, { plan, parentPath: parent.path, targetPath, actions, name: request.name.trim() });
    return { status: "ready", plan };
  };
  const apply = async (rawRequest: unknown): Promise<{ status: "applied" | "failed"; receipt: OperationReceipt }> => {
    const request = parseApplyOperationRequest(rawRequest);
    const stored = plans.get(request.planId);
    if (!stored) throw new Error("The operation preview is unavailable; preview it again.");
    plans.delete(request.planId);
    const completed: { action: PlannedAction; status: OperationActionReceipt["status"] }[] = [];
    const createdFiles: string[] = [];
    const createdDirectories: string[] = [];
    const gitDirectory = join(stored.targetPath, ".git");
    let activeAction: PlannedAction | undefined;
    try {
      const parent = await currentDirectory(stored.parentPath);
      if (
        parent !== stored.parentPath ||
        !isWithin(parent, stored.targetPath) ||
        (await underUserData(stored.targetPath))
      )
        throw new Error("The approved target is no longer safe.");
      if ((await targetState(stored.targetPath)) === "non-empty")
        throw new Error("The approved target is no longer empty.");
      for (const action of stored.actions) {
        activeAction = action;
        if (action.kind === "create-directory") {
          try {
            const details = await lstat(action.absolutePath);
            if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("The approved directory changed.");
          } catch (error: unknown) {
            if (!isMissing(error)) throw error;
            await mkdir(action.absolutePath);
            createdDirectories.push(action.absolutePath);
          }
        } else {
          try {
            await lstat(action.absolutePath);
            throw new Error("The approved file already exists.");
          } catch (error: unknown) {
            if (!isMissing(error)) throw error;
          }
          const temporaryPath = `${action.absolutePath}.${randomUUID()}.tmp`;
          try {
            await write(temporaryPath, action.content ?? "", { encoding: "utf8", mode: 0o644 });
            await chmod(temporaryPath, 0o644);
            try {
              await lstat(action.absolutePath);
              throw new Error("The approved file appeared during apply.");
            } catch (error: unknown) {
              if (!isMissing(error)) throw error;
            }
            await rename(temporaryPath, action.absolutePath);
            createdFiles.push(action.absolutePath);
            await chmod(action.absolutePath, 0o644);
          } finally {
            await unlink(temporaryPath).catch(() => undefined);
          }
        }
        completed.push({ action, status: "applied" });
      }
      let commit: string | undefined;
      if (stored.plan.git.mode === "init-and-commit") {
        const result = await git.initAndCommit(stored.targetPath, "Create personal marketplace");
        if (result.status !== "committed") throw new Error(result.diagnostic);
        commit = result.commit;
      }
      const registration = await registry.registerSourceByPath(stored.targetPath, stored.name);
      if (registration.status !== "ready")
        throw new Error("The marketplace was created but could not be registered safely.");
      const receiptActions = completed
        .map(({ action, status }) => ({ ...action, status }))
        .map(({ absolutePath: _absolutePath, content: _content, ...action }) => action);
      const receipt: OperationReceipt = {
        operationId: randomUUID(),
        kind: stored.plan.kind,
        status: "applied",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        actions: receiptActions,
        git: { mode: stored.plan.git.mode, ...(commit ? { commit } : {}) },
        registered: { sourceId: registration.entry.ref.id },
        manifests: stored.actions
          .filter((action) => action.manifest)
          .map((action) => ({ relativePath: action.relativePath, afterHash: hashContent(action.content ?? "") })),
      };
      const delivered = await persistWorkshopReceipt(receipt, stored.targetPath, {
        userDataPath,
        operationStore: store,
      });
      return { status: "applied", receipt: delivered };
    } catch (error: unknown) {
      await rollback(
        createdFiles,
        createdDirectories,
        stored.plan.git.mode === "init-and-commit" ? gitDirectory : "",
      ).catch(() => undefined);
      const failedAction =
        activeAction && !completed.some(({ action }) => action === activeAction)
          ? [{ ...activeAction, status: "failed" as const }]
          : [];
      const actionReceipts = [
        ...completed.map(({ action }) => ({ ...action, status: "rolled-back" as const })),
        ...failedAction,
      ].map(({ absolutePath: _absolutePath, content: _content, ...action }) => action);
      const receipt = failedReceipt(stored.plan, now(), actionReceipts);
      await store.append(receipt).catch(() => undefined);
      return { status: "failed", receipt };
    }
  };
  return { pickParent, preview, apply };
}
import { persistWorkshopReceipt } from "./workshop-delivery/receipt";
