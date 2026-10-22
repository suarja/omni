import { workshopPushWarnings } from "./workshop-delivery/plan";
import { planDisconnectedAgentRestore } from "./operations-disconnect-agents-restore";
import { planExactAgentSettingsRestore } from "./agent-settings-restore";
import { agentHomeDir } from "./agent-harnesses";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type {
  OperationAction,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest, type ApplyOperationResponse } from "../shared/operations-ipc";
import { parsePreviewRestoreRequest } from "../shared/operations-import-ipc";
import type { OperationStore } from "./operation-store";
import type { GitCli } from "./git-cli";
import { hashContent } from "./marketplace-manifests";
import {
  backupFiles,
  ensureDirectories,
  readRegularFile,
  removeFileOrEmptyDirectories,
  safePath,
  writeAtomically,
} from "./operation-files";
import { mcpCliPath } from "./agent-harnesses";
import type { ResourceOptions } from "./omni-resources";
import { planInstallAgentsRestore, settingsRemovalAction } from "./operations-install-agents-restore";
import { harnessSettingRestoreAction, settingsRestorePlan } from "./operations-harness-setting";
import { isMissing } from "./fs-optional";
import { receiptRoot, type ReceiptRootOptions } from "./operations-receipt-diff";
import { readRegisteredSource } from "./operations-paths";
import { describeRestoreFiles } from "./restore-file-preview";
type PlannedAction = OperationAction & Readonly<{ absolutePath: string; content?: string | Uint8Array }>;
type RestorePlan = Readonly<{
  plan: OperationPlan;
  original: OperationReceipt;
  root: string;
  actions: readonly PlannedAction[];
  prepared?: boolean;
}>;
type SettingsRestoreEntry = Parameters<typeof settingsRestorePlan>[4] extends Map<string, infer T> ? T : never;
type RestoreOptions = ResourceOptions &
  Readonly<{
    userDataPath: string;
    homeDir?: string;
    cliPath?: string;
    now?: () => number;
    operationStore: OperationStore;
    git: GitCli;
    composite?: Readonly<{
      preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
      apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
    }>;
  }>;
async function currentHash(path: string): Promise<string | undefined> {
  try {
    return hashContent(await readFile(path));
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
function block(reason: string, diagnostic: string): PreviewMarketplaceResponse {
  return { status: "blocked", reason, diagnostic };
}
async function removableDirectories(
  root: string,
  packageRoot: string,
  files: readonly string[],
  includePackageRoot: boolean,
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const file of files) {
    let current = dirname(file);
    while (current !== "." && current !== packageRoot && current.startsWith(`${packageRoot}/`)) {
      candidates.add(current);
      current = dirname(current);
    }
  }
  if (includePackageRoot) candidates.add(packageRoot);
  const removedFiles = new Set(files);
  const removedDirs = new Set<string>();
  for (const directory of [...candidates].sort((left, right) => right.split("/").length - left.split("/").length)) {
    const absolute = join(root, directory);
    const entries = await readdir(absolute).catch(() => [] as string[]);
    if (
      entries.length > 0 &&
      entries.every((entry) => removedFiles.has(`${directory}/${entry}`) || removedDirs.has(`${directory}/${entry}`))
    )
      removedDirs.add(directory);
  }
  return [...removedDirs].sort((left, right) => right.split("/").length - left.split("/").length);
}
async function createdDirectoriesToRemove(
  root: string,
  receipt: OperationReceipt,
  files: readonly string[],
): Promise<string[]> {
  const created = receipt.actions
    .filter((action) => action.kind === "create-directory" && action.status === "applied")
    .map((action) => action.relativePath)
    .sort((left, right) => right.split("/").length - left.split("/").length);
  const removedFiles = new Set(files);
  const removedDirs = new Set<string>();
  for (const directory of created) {
    const entries = await readdir(join(root, directory)).catch(() => undefined);
    if (!entries) continue;
    if (entries.every((entry) => removedFiles.has(`${directory}/${entry}`) || removedDirs.has(`${directory}/${entry}`)))
      removedDirs.add(directory);
  }
  return [...removedDirs];
}
function commitMessage(receipt: OperationReceipt): string {
  if (receipt.kind === "make-compatible") {
    const harness = receipt.harness === "codex" ? "Codex" : "Claude Code";
    return `Restore ${receipt.displayTarget} (undo make compatible with ${harness})`;
  }
  if (receipt.kind === "write-skill") {
    const skill = receipt.files?.[0]?.relativePath.match(/skills\/([^/]+)\//u)?.[1] ?? "skill";
    const verb = receipt.skillMode === "update" ? "undo update of" : "remove";
    return `Restore ${basename(receipt.displayTarget)} (${verb} skill ${skill})`;
  }
  return `Restore ${restoredName(receipt)} from ${basename(packageRootFromReceipt(receipt))}`;
}
function restoredName(receipt: OperationReceipt): string {
  const path = receipt.source?.relativePath ?? receipt.displayTarget;
  const file = basename(path);
  return file === "SKILL.md" ? basename(dirname(path)) : file.replace(new RegExp(`${extname(file)}$`), "");
}
function packageRootFromReceipt(receipt: OperationReceipt): string {
  const manifest = receipt.manifests?.find((item) => item.relativePath.endsWith("/omni.plugin.json"));
  if (manifest) return dirname(manifest.relativePath);
  const file = receipt.files?.[0];
  return file ? file.relativePath.split("/").slice(0, 2).join("/") : "packages";
}
function settingsRelativePath(displayTarget: string): string {
  return displayTarget.startsWith("~/") ? displayTarget.slice(2) : displayTarget;
}
function planSettingsRestore(
  original: OperationReceipt,
  homeDir: string,
  action: Parameters<typeof settingsRestorePlan>[2],
  notes: readonly string[],
  plans: Map<string, RestorePlan>,
): PreviewMarketplaceResponse {
  const settingsPlans = new Map<string, SettingsRestoreEntry>();
  const response = settingsRestorePlan(original, homeDir, action, notes, settingsPlans);
  if (response.status === "ready") {
    const stored = settingsPlans.get(response.plan.planId);
    if (stored) plans.set(response.plan.planId, stored);
  }
  return response;
}
function restoredActions(receipt: OperationReceipt, root: string, backupRoot: string): readonly PlannedAction[] {
  const actions: PlannedAction[] = (receipt.files ?? []).map((file) => ({
    kind: "delete-file",
    relativePath: file.relativePath,
    absolutePath: join(root, file.relativePath),
  }));
  const manifests = (receipt.manifests ?? []).map((manifest) => {
    const backupPath = join(backupRoot, manifest.relativePath);
    return manifest.beforeHash === undefined
      ? {
          kind: "delete-file" as const,
          relativePath: manifest.relativePath,
          absolutePath: join(root, manifest.relativePath),
          manifest: true,
        }
      : {
          kind: "write-file" as const,
          relativePath: manifest.relativePath,
          byteLength: 0,
          manifest: true,
          absolutePath: join(root, manifest.relativePath),
          content: backupPath,
        };
  });
  return [...actions, ...manifests];
}
async function restoredSkillActions(
  receipt: OperationReceipt,
  root: string,
  backupRoot: string,
): Promise<readonly PlannedAction[]> {
  const actions: PlannedAction[] = [];
  const fileRecords = receipt.files ?? [];
  for (const action of receipt.actions) {
    if (action.manifest || (action.kind !== "write-file" && action.kind !== "delete-file")) continue;
    const record = fileRecords.find((file) => file.relativePath === action.relativePath);
    if (action.kind === "delete-file") {
      const content = await readFile(join(backupRoot, action.relativePath));
      actions.push({
        kind: "write-file",
        relativePath: action.relativePath,
        byteLength: Buffer.byteLength(content),
        absolutePath: join(root, action.relativePath),
        content,
      });
    } else if (record?.previousHash) {
      const content = await readFile(join(backupRoot, action.relativePath));
      actions.push({
        kind: "write-file",
        relativePath: action.relativePath,
        byteLength: Buffer.byteLength(content),
        absolutePath: join(root, action.relativePath),
        content,
      });
    } else {
      actions.push({
        kind: "delete-file",
        relativePath: action.relativePath,
        absolutePath: join(root, action.relativePath),
      });
    }
  }
  const manifestActions = restoredActions(receipt, root, backupRoot).filter((action) => action.manifest);
  return [...actions, ...manifestActions];
}
export function createRestoreOperations(options: RestoreOptions): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  prepare(planId: string, intentId: string): Promise<void>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const now = options.now ?? Date.now;
  const plans = new Map<string, RestorePlan>();
  const receiptMarketplace = async (receipt: OperationReceipt) => {
    if (receipt.kind === "write-skill") {
      const sourceId = receipt.registered?.sourceId;
      return sourceId ? readRegisteredSource(options.userDataPath, sourceId, "personal") : undefined;
    }
    const root = await receiptRoot(receipt, options);
    return root ? { root } : undefined;
  };
  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parsePreviewRestoreRequest(raw);
    const loaded = await options.operationStore.read();
    if (loaded.status !== "ready") return block("operations-unavailable", loaded.diagnostic);
    const original = loaded.receipts.find(
      (receipt) =>
        receipt.operationId === request.operationId &&
        (receipt.kind === "import-artifact" ||
          receipt.kind === "describe-plugin" ||
          receipt.kind === "make-compatible" ||
          receipt.kind === "write-skill" ||
          receipt.kind === "install-agents" ||
          receipt.kind === "disconnect-agents" ||
          receipt.kind === "register-mcp" ||
          receipt.kind === "write-harness-setting" ||
          receipt.kind === "add-to-project") &&
        (receipt.status === "applied" || (receipt.kind === "import-artifact" && Boolean(receipt.children?.length))) &&
        receipt.restored !== true,
    );
    if (!original) return block("restore-unavailable", "The operation receipt is unavailable or was already restored.");
    if (original.kind === "add-to-project" || (original.kind === "import-artifact" && original.children?.length))
      return options.composite
        ? options.composite.preview(raw)
        : block("restore-child-unavailable", "Cannot restore add-to-project: composite restore is unavailable.");
    if (original.kind === "register-mcp" || original.kind === "write-harness-setting") {
      const homeDir = agentHomeDir(options);
      const manifest = original.manifests?.[0];
      if (manifest) {
        try {
          const exact = await planExactAgentSettingsRestore(
            homeDir,
            join(options.userDataPath, "omni/backups", original.operationId),
            settingsRelativePath(manifest.relativePath),
            manifest,
          );
          if (exact) return planSettingsRestore(original, homeDir, exact, [], plans);
        } catch {
          return block(
            "restore-backup-missing",
            "The agent settings backup is unavailable or changed. Preserve it before restoring.",
          );
        }
      }
    }
    if (original.kind === "register-mcp") {
      const homeDir = agentHomeDir(options);
      const manifest = original.manifests?.[0];
      if (!manifest) return block("restore-unavailable", "The provider settings receipt is missing its manifest.");
      const harness = original.harness;
      if (!harness) return block("restore-unavailable", "The provider settings receipt is missing its harness.");
      const removed = await settingsRemovalAction(
        harness,
        homeDir,
        original.cliPath ?? mcpCliPath(options),
        options.userDataPath,
        manifest,
      );
      if (removed.status === "blocked") return removed;
      return planSettingsRestore(original, homeDir, removed.action, removed.notes, plans);
    }
    if (original.kind === "write-harness-setting") {
      const homeDir = agentHomeDir(options);
      const restored = await harnessSettingRestoreAction(homeDir, original);
      if (restored.status === "blocked") return restored;
      return planSettingsRestore(original, homeDir, restored.action, restored.notes, plans);
    }
    if (original.kind === "install-agents" || original.kind === "disconnect-agents") {
      const homeDir = agentHomeDir(options);
      const backupRoot = join(options.userDataPath, "omni", "backups", original.operationId);
      const restored =
        original.kind === "disconnect-agents"
          ? await planDisconnectedAgentRestore(original, homeDir, backupRoot)
          : await planInstallAgentsRestore(
              original,
              homeDir,
              backupRoot,
              original.cliPath ?? mcpCliPath(options),
              options.userDataPath,
            );
      if (restored.status === "blocked") return restored;
      const plan: OperationPlan = {
        planId: randomUUID(),
        kind: "restore-import",
        displayTarget: original.displayTarget,
        actions: restored.actions.map(({ absolutePath: _path, content: _content, ...action }) => action),
        git: { mode: "not-a-repository", warnings: [] },
        ...(restored.notes?.length ? { notes: restored.notes } : {}),
      };
      plans.set(plan.planId, { plan, original, root: homeDir, actions: restored.actions });
      return { status: "ready", plan };
    }
    const marketplace = await receiptMarketplace(original);
    if (!marketplace) return block("personal-marketplace-missing", "The marketplace of this operation is unavailable.");
    const packageId = original.displayTarget;
    const packageRoot = packageRootFromReceipt(original);
    for (const file of original.files ?? []) {
      const location = join(marketplace.root, file.relativePath);
      const actual = await currentHash(location);
      const deleted = original.actions.some(
        (action) => action.kind === "delete-file" && !action.manifest && action.relativePath === file.relativePath,
      );
      if ((!deleted && actual !== file.contentHash) || (deleted && actual !== undefined))
        return block("restore-drift", "A file created by this import has changed; restore is blocked.");
    }
    const backupRoot = join(options.userDataPath, "omni", "backups", original.operationId);
    let actions: PlannedAction[];
    if (original.kind === "write-skill") {
      try {
        actions = [...(await restoredSkillActions(original, marketplace.root, backupRoot))];
      } catch {
        return block("restore-backup-missing", "The pre-write skill backup is unavailable.");
      }
    } else {
      actions = [...restoredActions(original, marketplace.root, backupRoot)];
    }
    for (const manifest of original.manifests ?? []) {
      const actual = await currentHash(join(marketplace.root, manifest.relativePath));
      if (actual !== manifest.afterHash)
        return block("restore-drift", "A manifest changed after this import; restore is blocked.");
      if (manifest.beforeHash !== undefined) {
        const backup = join(backupRoot, manifest.relativePath);
        try {
          const content = await readFile(backup, "utf8");
          if (hashContent(content) !== manifest.beforeHash)
            return block(
              "restore-backup-changed",
              "The pre-operation manifest backup changed. Preserve it and inspect the operation before restoring.",
            );
          const item = actions.find(
            (action) => action.relativePath === manifest.relativePath && action.kind === "write-file",
          );
          if (item)
            (item as { byteLength?: number; content?: string | Uint8Array }).byteLength = Buffer.byteLength(content);
          if (item) (item as { content?: string | Uint8Array }).content = content;
        } catch {
          return block("restore-backup-missing", "The pre-import manifest backup is unavailable.");
        }
      }
    }
    actions = await describeRestoreFiles(marketplace.root, actions);
    const deletable = [
      ...(original.kind === "write-skill"
        ? original.actions
            .filter(
              (action) =>
                action.kind === "write-file" &&
                !action.manifest &&
                !original.files?.find((file) => file.relativePath === action.relativePath)?.previousHash,
            )
            .map((action) => action.relativePath)
        : (original.files ?? []).map((file) => file.relativePath)),
      ...(original.manifests ?? [])
        .filter((manifest) => manifest.beforeHash === undefined)
        .map((manifest) => manifest.relativePath),
    ];
    const createdPackageManifest =
      original.manifests?.some(
        (manifest) => manifest.relativePath === `${packageRoot}/omni.plugin.json` && manifest.beforeHash === undefined,
      ) ?? false;
    const directories =
      original.kind === "make-compatible"
        ? await createdDirectoriesToRemove(marketplace.root, original, deletable)
        : await removableDirectories(marketplace.root, packageRoot, deletable, createdPackageManifest);
    actions.push(
      ...directories.map((relativePath) => ({
        kind: "delete-directory" as const,
        relativePath,
        absolutePath: join(marketplace.root, relativePath),
      })),
    );
    const mode =
      original.git.mode === "disabled"
        ? ("disabled" as const)
        : !(await options.git.isGitAvailable())
          ? ("unavailable" as const)
          : (await options.git.isRepositoryRoot(marketplace.root))
            ? ("commit" as const)
            : ("enclosing-repository" as const);
    const warnings =
      mode === "enclosing-repository"
        ? ["The marketplace is inside another repository; Git metadata will not be written."]
        : mode === "unavailable"
          ? ["Git is unavailable; the restore will still be applied."]
          : [];
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "restore-import",
      displayTarget: packageId,
      actions: actions.map(({ absolutePath: _path, content: _content, ...action }) => action),
      git: { mode, warnings: workshopPushWarnings(mode, warnings) },
    };
    plans.set(plan.planId, { plan, original, root: marketplace.root, actions });
    return { status: "ready", plan };
  };
  const prepare = async (planId: string, intentId: string): Promise<void> => {
    const stored = plans.get(planId);
    if (!stored) throw new Error("The approved restore plan is unavailable; preview it again.");
    if (stored.prepared) return;
    const paths: string[] = [];
    const expected = new Map<string, string>();
    for (const action of stored.actions) {
      if (action.kind === "delete-directory") continue;
      const current = await readRegularFile(stored.root, action.relativePath);
      if (!current) continue;
      paths.push(action.relativePath);
      expected.set(action.relativePath, hashContent(current));
    }
    const backupRoot = join(options.userDataPath, "omni", "backups", "skill-intents", intentId, "before-restore");
    await backupFiles(stored.root, backupRoot, paths);
    for (const path of paths) {
      const copy = await readRegularFile(backupRoot, path);
      if (!copy || hashContent(copy) !== expected.get(path))
        throw new Error(`Restore recovery file could not be verified: ${path}`);
    }
    plans.set(planId, { ...stored, prepared: true });
  };
  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    if (options.composite) {
      const composite = await options.composite.apply(raw);
      if (composite) return composite;
    }
    const request = parseApplyOperationRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored) return undefined;
    plans.delete(request.planId);
    const completed: PlannedAction[] = [];
    try {
      const agentRestore =
        stored.original.kind === "register-mcp" ||
        stored.original.kind === "install-agents" ||
        stored.original.kind === "disconnect-agents" ||
        stored.original.kind === "write-harness-setting";
      const marketplace = agentRestore ? undefined : await receiptMarketplace(stored.original);
      if (!agentRestore && (!marketplace || marketplace.root !== stored.root))
        throw new Error("The approved marketplace target is no longer safe.");
      const restoreOperationId = randomUUID();
      const restoreBackupRoot = join(options.userDataPath, "omni", "backups", restoreOperationId);
      for (const action of stored.actions) {
        const settingsAction =
          agentRestore &&
          (action.relativePath === ".claude.json" ||
            action.relativePath === ".codex/config.toml" ||
            action.relativePath === ".claude/settings.json" ||
            action.relativePath === ".codex/hooks.json");
        if (action.kind === "create-directory") {
          const path = await safePath(stored.root, action.relativePath);
          const exists = await lstat(path)
            .then(() => true)
            .catch((error: unknown) => (isMissing(error) ? false : Promise.reject(error)));
          if (exists)
            throw new Error(
              `The approved restore directory ${action.relativePath} was recreated. Keep it before restoring.`,
            );
          await ensureDirectories(stored.root, action.relativePath);
        } else if (settingsAction) {
          const manifest = stored.original.manifests?.find(
            (item) => settingsRelativePath(item.relativePath) === action.relativePath,
          );
          if (!manifest) throw new Error("The approved provider settings receipt is incomplete.");
          if (action.kind === "delete-file") {
            if ((await currentHash(action.absolutePath)) !== manifest.afterHash)
              throw new Error("The approved provider settings target changed.");
            await removeFileOrEmptyDirectories(stored.root, action.relativePath, ".");
          } else {
            if ((await currentHash(action.absolutePath)) !== action.beforeHash)
              throw new Error("The approved provider settings target changed.");
            if (action.beforeHash !== undefined)
              await backupFiles(stored.root, restoreBackupRoot, [action.relativePath]);
            await writeAtomically(stored.root, action.relativePath, action.content ?? "");
            if ((await currentHash(action.absolutePath)) !== hashContent(action.content ?? ""))
              throw new Error("The restored provider settings file could not be verified.");
          }
        } else if (action.kind === "delete-file") {
          const expected =
            stored.original.files?.find((file) => file.relativePath === action.relativePath)?.contentHash ??
            stored.original.manifests?.find(
              (manifest) => settingsRelativePath(manifest.relativePath) === action.relativePath,
            )?.afterHash;
          if (expected && (await currentHash(action.absolutePath)) !== expected)
            throw new Error("The approved restore target changed.");
          await unlink(action.absolutePath);
        } else if (action.kind === "delete-directory") {
          if ((await readdir(action.absolutePath)).length !== 0)
            throw new Error("The approved restore directory is no longer empty.");
          await rmdir(action.absolutePath);
        } else {
          const expected =
            stored.original.manifests?.find(
              (manifest) => settingsRelativePath(manifest.relativePath) === action.relativePath,
            )?.afterHash ??
            stored.original.files?.find((file) => file.relativePath === action.relativePath)?.contentHash;
          const originallyDeleted = stored.original.actions.some(
            (originalAction) =>
              originalAction.kind === "delete-file" &&
              !originalAction.manifest &&
              originalAction.relativePath === action.relativePath,
          );
          if (originallyDeleted) {
            if ((await currentHash(action.absolutePath)) !== undefined)
              throw new Error("The approved restore target changed.");
          } else if (expected && (await currentHash(action.absolutePath)) !== expected)
            throw new Error("The approved restore manifest changed.");
          await writeAtomically(stored.root, action.relativePath, action.content ?? "");
        }
        completed.push(action);
      }
      let commit: string | undefined;
      if (stored.plan.git.mode === "commit") {
        const result = await options.git.commitAll(
          stored.root,
          commitMessage(stored.original),
          stored.actions.filter((action) => action.kind !== "delete-directory").map((action) => action.relativePath),
        );
        if (result.status !== "committed") throw new Error(result.diagnostic);
        commit = result.commit;
      }
      const receipt: OperationReceipt = {
        operationId: restoreOperationId,
        kind: "restore-import",
        status: "applied",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        actions: stored.actions.map(({ absolutePath: _path, content: _content, ...action }) => ({
          ...action,
          status: "applied" as const,
        })),
        git: { mode: stored.plan.git.mode, ...(commit ? { commit } : {}) },
        registered: null,
        restores: stored.original.operationId,
      };
      const delivered = await persistWorkshopReceipt(receipt, stored.root, options);
      const marked = await options.operationStore.markRestored(stored.original.operationId);
      if (marked.status !== "ready") throw new Error("The original import receipt could not be updated safely.");
      return { status: "applied", receipt: delivered };
    } catch (error: unknown) {
      // A restore cannot undo itself: deleted files are gone. Report exactly what happened.
      const diagnostic =
        error instanceof Error ? error.message.replace(/\/[^\s"]+/g, "<path>").slice(0, 200) : "The restore failed.";
      const receipt: OperationReceipt = {
        operationId: randomUUID(),
        kind: "restore-import",
        status: "failed",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        actions: stored.actions.map((item) => {
          const { absolutePath: _path, content: _content, ...action } = item;
          return {
            ...action,
            status: completed.some((done) => done.absolutePath === item.absolutePath)
              ? ("applied" as const)
              : ("failed" as const),
          };
        }),
        git: { mode: stored.plan.git.mode },
        registered: null,
        restores: stored.original.operationId,
        diagnostic,
      };
      await options.operationStore.append(receipt).catch(() => undefined);
      return { status: "failed", receipt };
    }
  };
  return { preview, prepare, apply };
}
import { persistWorkshopReceipt } from "./workshop-delivery/receipt";
