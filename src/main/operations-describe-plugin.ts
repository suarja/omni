import { StorefrontTargetError } from "../domain/source-roles";
import { receiptDiagnostic } from "./operation-diagnostics";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
  ApplyOperationResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest } from "../shared/operations-ipc";
import { parseDescribePluginRequest } from "../shared/plugin-description-ipc";
import type { OperationStore } from "./operation-store";
import type { GitCli } from "./git-cli";
import type { SettingsStore } from "./settings-store";
import { readActiveWorkshop } from "./operations-paths";
import { backupFiles, readRegularFile, safePath, writeAtomically, type FileWriter } from "./operation-files";
import { hashContent, json, manifestAction, parseObject, styleOf, type ManifestAction } from "./marketplace-manifests";
import { observedLayout, block } from "./operations-import-plan";

type Options = Readonly<{
  userDataPath: string;
  operationStore: OperationStore;
  git: GitCli;
  settingsStore: SettingsStore;
  now?: () => number;
  fileWriter?: FileWriter;
}>;
type Stored = Readonly<{
  plan: OperationPlan;
  root: string;
  sourceId: string;
  operationId: string;
  actions: readonly ManifestAction[];
}>;

async function descriptionActions(
  root: string,
  packageId: string,
  description: string,
): Promise<readonly ManifestAction[]> {
  const layout = await observedLayout(root);
  const plugin = layout.packages?.find((item) => item.relativeRoot === packageId);
  if (!plugin) throw new Error("The selected plugin is no longer observed. Refresh the marketplace.");
  const actions: ManifestAction[] = [];
  const pluginPaths = [
    `${packageId}/omni.plugin.json`,
    `${packageId}/.claude-plugin/plugin.json`,
    `${packageId}/.codex-plugin/plugin.json`,
  ];
  for (const path of pluginPaths) {
    const content = await readRegularFile(root, path);
    if (content === undefined) continue;
    const before = Buffer.from(content).toString("utf8");
    actions.push(manifestAction(root, path, json({ ...parseObject(before), description }, styleOf(before)), before));
  }
  if (!actions.length) throw new Error("The selected plugin has no writable manifest. Refresh the marketplace.");
  for (const path of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
    const content = await readRegularFile(root, path);
    if (content === undefined) continue;
    const before = Buffer.from(content).toString("utf8"),
      manifest = parseObject(before);
    if (!Array.isArray(manifest.plugins))
      throw new Error(`Cannot describe ${packageId.split("/").at(-1)}: the marketplace manifest has no plugin list.`);
    const plugins = manifest.plugins.map((value: unknown) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      const entry = value as Record<string, unknown>;
      const source =
        typeof entry.source === "string"
          ? entry.source
          : typeof entry.source === "object" && entry.source !== null
            ? (entry.source as Record<string, unknown>).path
            : undefined;
      return (typeof source === "string" && source.replace(/^\.\//u, "") === packageId) ||
        (source === undefined && entry.name === plugin.displayName)
        ? { ...entry, description }
        : entry;
    });
    if (JSON.stringify(plugins) !== JSON.stringify(manifest.plugins))
      actions.push(manifestAction(root, path, json({ ...manifest, plugins }, styleOf(before)), before));
  }
  for (const action of actions) await safePath(root, action.relativePath);
  return actions;
}

async function writeDescriptionFiles(
  stored: Stored,
  backupRoot: string,
  options: Options,
  applied: ManifestAction[],
): Promise<string | undefined> {
  const active = await readActiveWorkshop(options.userDataPath);
  if (active?.root !== stored.root || active.id !== stored.sourceId)
    throw new Error("The personal marketplace changed; preview the plugin again.");
  for (const action of stored.actions) {
    const bytes = await readRegularFile(stored.root, action.relativePath);
    if (!bytes || hashContent(bytes) !== action.beforeHash)
      throw new Error(
        `Cannot describe ${stored.plan.displayTarget.split("/").at(-1)}: a plugin manifest changed; preview again.`,
      );
  }
  await backupFiles(
    stored.root,
    backupRoot,
    stored.actions.map((action) => action.relativePath),
  );
  for (const action of stored.actions) {
    const bytes = await readRegularFile(stored.root, action.relativePath);
    if (!bytes || hashContent(bytes) !== action.beforeHash)
      throw new Error(
        `Cannot describe ${stored.plan.displayTarget.split("/").at(-1)}: a plugin manifest changed; preview again.`,
      );
    await writeAtomically(stored.root, action.relativePath, action.content, options.fileWriter);
    applied.push(action);
  }
  if (stored.plan.git.mode === "commit") {
    const result = await options.git.commitAll(
      stored.root,
      `Describe plugin ${stored.plan.displayTarget.split("/").at(-1)}`,
      stored.actions.map((action) => action.relativePath),
    );
    if (result.status !== "committed") throw new Error(result.diagnostic);
    return result.commit;
  }
  return undefined;
}

export function createDescribePluginOperations(options: Options): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const plans = new Map<string, Stored>();
  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parseDescribePluginRequest(raw);
    let marketplace: Awaited<ReturnType<typeof readActiveWorkshop>>;
    try {
      marketplace = await readActiveWorkshop(options.userDataPath);
    } catch (error) {
      if (error instanceof StorefrontTargetError) return block(error.code, error.message);
      throw error;
    }
    if (!marketplace)
      return block("personal-marketplace-missing", "Register a personal marketplace before describing a plugin.");
    try {
      const actions = await descriptionActions(marketplace.root, request.packageId, request.description);
      const mode = !(await options.settingsStore.read()).git.commitChanges
        ? "disabled"
        : !(await options.git.isGitAvailable())
          ? "unavailable"
          : (await options.git.isRepositoryRoot(marketplace.root))
            ? "commit"
            : "enclosing-repository";
      const plan: OperationPlan = {
        planId: randomUUID(),
        kind: "describe-plugin",
        displayTarget: request.packageId,
        actions: actions.map(({ absolutePath: _path, content: _content, beforeContent: _before, ...view }) => view),
        git: {
          mode,
          warnings:
            mode === "enclosing-repository"
              ? ["The marketplace is inside another repository; Git metadata will not be written."]
              : [],
        },
      };
      plans.set(plan.planId, {
        plan,
        root: marketplace.root,
        sourceId: marketplace.id,
        operationId: randomUUID(),
        actions,
      });
      return { status: "ready", plan };
    } catch (error) {
      return block(
        "plugin-description-unavailable",
        receiptDiagnostic(error, "The plugin cannot be described safely. Refresh the marketplace and preview again."),
      );
    }
  };
  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw),
      stored = plans.get(request.planId);
    if (!stored) return undefined;
    plans.delete(request.planId);
    const backupRoot = join(options.userDataPath, "omni/backups", stored.operationId);
    const applied: ManifestAction[] = [];
    const rolledBack = new Set<string>();
    let commit: string | undefined, diagnostic: string | undefined;
    try {
      commit = await writeDescriptionFiles(stored, backupRoot, options, applied);
    } catch (error) {
      diagnostic = receiptDiagnostic(
        error,
        "The plugin description could not be saved safely. Preview again or inspect its operation backup.",
      );
      for (const action of [...applied].reverse()) {
        try {
          await writeAtomically(stored.root, action.relativePath, action.beforeContent!, options.fileWriter);
          rolledBack.add(action.relativePath);
        } catch {
          diagnostic += " A manifest could not be restored. Inspect its recorded action and operation backup.";
        }
      }
    }
    const receipt: OperationReceipt = {
      operationId: stored.operationId,
      kind: "describe-plugin",
      status: diagnostic ? "failed" : "applied",
      appliedAt: new Date((options.now ?? Date.now)()).toISOString(),
      displayTarget: stored.plan.displayTarget,
      actions: stored.plan.actions.map((action) => ({
        ...action,
        status: !diagnostic
          ? "applied"
          : rolledBack.has(action.relativePath)
            ? "rolled-back"
            : applied.some((done) => done.relativePath === action.relativePath)
              ? "applied"
              : "failed",
      })),
      git: { mode: stored.plan.git.mode, ...(commit ? { commit } : {}) },
      registered: { sourceId: stored.sourceId },
      manifests: stored.actions.map((action) => ({
        relativePath: action.relativePath,
        beforeHash: action.beforeHash!,
        afterHash: hashContent(action.content),
      })),
      ...(request.provenance ? { provenance: request.provenance } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
    const persisted = await options.operationStore.append(receipt);
    if (persisted.status !== "ready")
      throw new Error("The plugin description receipt could not be saved. Preserve its backup and refresh History.");
    return { status: receipt.status, receipt };
  };
  return { preview, apply };
}
