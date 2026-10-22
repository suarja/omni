import { workshopPushWarnings } from "./workshop-delivery/plan";
import { StorefrontTargetError } from "../domain/source-roles";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createLocalInventoryPort } from "../adapters/inventory/local-filesystem";
import { detectSourceLayout } from "../adapters/inventory/source-layout";
import { buildCompatibilityReport, type CompatibilityRemotePackage } from "../domain/compatibility-report";
import { projectMarketplaceEntry, projectPluginManifest, type Harness } from "../domain/harness-projection";
import { parseMarketplaceManifest } from "../domain/marketplace-format";
import type { InventorySnapshot, ObservedPackage } from "../domain/inventory";
import {
  parseApplyOperationRequest,
  type ApplyOperationResponse,
  type OperationAction,
  type OperationPlan,
  type OperationReceipt,
  type PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parsePreviewCompatibleRequest, type PreviewCompatibleRequest } from "../shared/operations-compatible-ipc";
import type { RegistryGrantStore } from "./registry-ipc";
import type { OperationStore } from "./operation-store";
import type { GitCli } from "./git-cli";
import type { SettingsStore } from "./settings-store";
import { readRegisteredSource } from "./operations-paths";
import {
  backupFiles,
  ensureDirectories,
  readRegularFile,
  removeDirectoryIfEmpty,
  removeFileOrEmptyDirectories,
  restoreBackup,
  writeAtomically,
} from "./operation-files";
import {
  harnessMarketplaces,
  hashContent,
  json,
  manifestAction,
  packageManifestBirth,
  packageMetadata,
  marketplaceManifestBirth,
  parseObject,
  safeStat,
  addDirectories,
  observedArtifacts,
  readArtifactContent,
} from "./marketplace-manifests";
import { readOptionalText } from "./fs-optional";
import { manifestUpdate, remoteEntry, rootManifestUpdate } from "./marketplace-manifest-merge";

type PlannedAction = OperationAction &
  Readonly<{
    absolutePath: string;
    content?: string;
    applyContent?: string;
    beforeContent?: string;
    beforeHash?: string;
    apply?: boolean;
  }>;
type ManifestReceipt = Readonly<{ relativePath: string; beforeHash?: string; afterHash: string }>;
type StoredPlan = Readonly<{
  plan: OperationPlan;
  operationId: string;
  root: string;
  actions: readonly PlannedAction[];
  manifests: readonly ManifestReceipt[];
  commitMessage: string;
  harness: Harness;
  sourceId: string;
}>;
type CompatibleWriter = (
  path: string,
  content: string | Uint8Array,
  options: { encoding: "utf8"; mode: number },
) => Promise<void>;
type CompatibleOptions = Readonly<{
  userDataPath: string;
  now?: () => number;
  operationStore: OperationStore;
  git: GitCli;
  fileWriter?: CompatibleWriter;
  settingsStore?: SettingsStore;
}>;

const SAFE_WARNING = "The marketplace is inside another repository; Git metadata will not be written.";

function block(reason: string, diagnostic: string): PreviewMarketplaceResponse {
  return { status: "blocked", reason, diagnostic };
}

function unsupportedHarness(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    "harness" in raw &&
    (raw as { harness?: unknown }).harness !== "claude-code" &&
    (raw as { harness?: unknown }).harness !== "codex"
  );
}

function harnessDirectory(harness: Harness): string {
  return harness === "codex" ? ".codex-plugin" : ".claude-plugin";
}

function pluginPath(packagePath: string, harness: Harness): string {
  return `${packagePath}/${harnessDirectory(harness)}/plugin.json`;
}

function marketplacePath(harness: Harness): string {
  return harness === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json";
}

function codexDisplayName(other: { manifest: Record<string, unknown> } | undefined): string | undefined {
  const metadata = other?.manifest.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  return typeof record.description === "string"
    ? record.description
    : typeof record.name === "string"
      ? record.name
      : undefined;
}

function actionView(action: PlannedAction): OperationAction {
  return {
    kind: action.kind,
    relativePath: action.relativePath,
    ...(action.byteLength === undefined ? {} : { byteLength: action.byteLength }),
    ...(action.manifest === undefined ? {} : { manifest: action.manifest }),
    ...(action.diff === undefined ? {} : { diff: action.diff }),
  };
}

function packageForRequest(packages: readonly ObservedPackage[], packageId: string | undefined): ObservedPackage[] {
  if (!packageId) return [...packages];
  return packages.filter((item) => item.id === packageId || item.relativeRoot === packageId);
}

export function createCompatibleOperations(
  _grants: RegistryGrantStore,
  options: CompatibleOptions,
): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const now = options.now ?? Date.now;
  const plans = new Map<string, StoredPlan>();
  const write = options.fileWriter
    ? (path: string, content: string | Uint8Array, writeOptions: { encoding?: BufferEncoding; mode?: number }) =>
        options.fileWriter!(path, content, {
          encoding: "utf8",
          mode: writeOptions.mode ?? 0o644,
        })
    : undefined;

  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    let request: PreviewCompatibleRequest;
    try {
      request = parsePreviewCompatibleRequest(raw);
    } catch (error: unknown) {
      if (unsupportedHarness(raw)) return block("harness-unsupported", "Only Claude Code and Codex are supported.");
      throw error;
    }
    let marketplace: Awaited<ReturnType<typeof readRegisteredSource>>;
    try {
      marketplace = await readRegisteredSource(options.userDataPath, request.sourceId);
    } catch (error) {
      if (error instanceof StorefrontTargetError) return block(error.code, error.message);
      return block("source-missing", "The selected source is unavailable.");
    }
    if (!marketplace) return block("source-missing", "The selected source is unavailable.");
    let inventory: InventorySnapshot;
    try {
      const detected = await detectSourceLayout(createLocalInventoryPort(marketplace.root), "source");
      inventory = {
        rootHandle: request.sourceId,
        displayRoot: marketplace.name,
        observedAt: new Date(now()).toISOString(),
        harnesses: [],
        artifacts: detected.artifacts,
        packages: detected.packages ?? [],
        ...(detected.marketplace ? { marketplace: detected.marketplace } : {}),
        diagnostics: detected.diagnostics,
        gitScopes: [],
      };
    } catch {
      return block("source-missing", "The source could not be observed safely.");
    }
    const observedPackages = inventory.packages ?? [];
    const packages = packageForRequest(observedPackages, request.packageId);
    if (request.packageId && packages.length === 0) {
      return block("source-missing", "The selected package is no longer observed.");
    }
    for (const packageInfo of packages) {
      for (const manifestPath of packageInfo.manifestPaths.filter((path) => path.endsWith("plugin.json"))) {
        const content = await readOptionalText(join(marketplace.root, manifestPath));
        if (!content) continue;
        try {
          parseObject(content);
        } catch {
          return block("manifest-invalid", `Invalid manifest: ${manifestPath}.`);
        }
      }
    }
    const artifacts = await readArtifactContent(marketplace.root, observedArtifacts(inventory));
    const report = buildCompatibilityReport({
      harness: request.harness,
      packageId: request.packageId,
      marketplace: {
        packages,
        artifacts,
        remotePackages: request.packageId ? [] : inventory.marketplace?.remotePackages,
      },
    });
    let omniManifest: ReturnType<typeof parseMarketplaceManifest>;
    let omni: string | undefined;
    try {
      const existingClaude = await readOptionalText(join(marketplace.root, ".claude-plugin/marketplace.json"));
      let observedName = marketplace.name;
      if (existingClaude) {
        try {
          const manifest = parseObject(existingClaude);
          if (typeof manifest.name === "string" && manifest.name.trim()) observedName = manifest.name;
        } catch {
          return block("manifest-invalid", "Invalid manifest: .claude-plugin/marketplace.json.");
        }
      }
      const birth = await marketplaceManifestBirth(marketplace.root, now(), observedName);
      omni = birth.beforeContent;
      omniManifest = birth.manifest;
    } catch {
      return block("manifest-invalid", "Invalid manifest: omni.marketplace.json.");
    }
    if (!omni) {
      omniManifest = {
        ...omniManifest,
        packages: observedPackages.map((item) => ({ path: item.relativeRoot })),
      };
    }
    const actions: PlannedAction[] = [];
    const packageEntries: Record<string, unknown>[] = [];
    for (const packageInfo of packages) {
      const metadata = await packageMetadata(marketplace.root, packageInfo.relativeRoot, inventory.artifacts);
      let packageBirth: Awaited<ReturnType<typeof packageManifestBirth>>;
      try {
        packageBirth = await packageManifestBirth(marketplace.root, packageInfo.relativeRoot, metadata);
      } catch {
        return block("manifest-invalid", `Invalid manifest: ${packageInfo.relativeRoot}/omni.plugin.json.`);
      }
      const manifest = packageBirth.manifest;
      if (!packageBirth.beforeContent) {
        actions.push(manifestAction(marketplace.root, packageBirth.relativePath, packageBirth.content));
      }
      const entry = projectMarketplaceEntry(manifest, packageInfo.relativeRoot, request.harness);
      packageEntries.push(entry);
      const projected = projectPluginManifest(manifest, request.harness) as Record<string, unknown>;
      try {
        const update = await manifestUpdate(
          marketplace.root,
          pluginPath(packageInfo.relativeRoot, request.harness),
          projected,
          new Set(request.keepUpdates ?? []),
        );
        if (update) actions.push(update);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith("manifest-invalid:")) {
          return block("manifest-invalid", `Invalid manifest: ${error.message.slice("manifest-invalid:".length)}.`);
        }
        throw error;
      }
    }
    if (!omni) actions.push(manifestAction(marketplace.root, "omni.marketplace.json", json(omniManifest)));
    const otherHarness = request.harness === "codex" ? "claude-code" : "codex";
    const harnesses = await harnessMarketplaces(marketplace.root);
    const other = harnesses.find((item) => item.harness === otherHarness);
    const existingOtherName = other?.manifest.name;
    const displayNameValue = request.harness === "codex" ? codexDisplayName(other) : undefined;
    const remoteEntries = request.packageId
      ? []
      : (inventory.marketplace?.remotePackages ?? [])
          .map((remote) => remoteEntry(remote as CompatibilityRemotePackage, request.harness))
          .filter((entry): entry is Record<string, unknown> => entry !== undefined);
    const targetPath = marketplacePath(request.harness);
    const targetName =
      typeof omniManifest.name === "string"
        ? omniManifest.name
        : typeof existingOtherName === "string"
          ? existingOtherName
          : marketplace.name;
    try {
      const targetUpdate = await rootManifestUpdate(
        marketplace.root,
        targetPath,
        targetName,
        [...packageEntries, ...remoteEntries],
        new Set(request.keepUpdates ?? []),
        displayNameValue,
      );
      if (targetUpdate) actions.push(targetUpdate);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith("manifest-invalid:")) {
        return block("manifest-invalid", `Invalid manifest: ${error.message.slice("manifest-invalid:".length)}.`);
      }
      throw error;
    }
    const projectionActions = [...actions];
    const applyProjectionActions = projectionActions.filter((action) => action.apply !== false);
    const directories: PlannedAction[] = addDirectories(
      marketplace.root,
      applyProjectionActions.map((action) => action.relativePath),
    );
    for (const action of directories) {
      const details = await safeStat(action.absolutePath);
      if (details && (!details.isDirectory() || details.isSymbolicLink())) {
        return block("target-unsafe", "The marketplace destination contains an unsafe directory.");
      }
    }
    const newDirectories = [] as PlannedAction[];
    for (const action of directories) {
      if (!(await safeStat(action.absolutePath))) newDirectories.push(action);
    }
    const applyActions = [...newDirectories, ...applyProjectionActions];
    const previewActions = [...newDirectories, ...projectionActions];
    const settings = options.settingsStore
      ? await options.settingsStore.read()
      : {
          schemaVersion: 6 as const,
          git: { commitChanges: true },
          agents: {
            approval: { personalMarketplace: "conversation" as const, projects: "omni" as const },
            guard: { warnProjectIds: [] },
          },
        };
    const available = await options.git.isGitAvailable();
    const mode = !settings.git.commitChanges
      ? ("disabled" as const)
      : !available
        ? ("unavailable" as const)
        : (await options.git.isRepositoryRoot(marketplace.root))
          ? ("commit" as const)
          : ("enclosing-repository" as const);
    const warnings =
      mode === "enclosing-repository"
        ? [SAFE_WARNING]
        : mode === "unavailable"
          ? ["Git is unavailable; the compatibility files will still be written."]
          : [];
    const visibleIn = [
      "omni" as const,
      request.harness,
      ...harnesses.filter((item) => item.harness !== request.harness).map((item) => item.harness),
    ].filter((item, index, values) => values.indexOf(item) === index);
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "make-compatible",
      displayTarget: request.packageId ?? marketplace.name,
      actions: previewActions.map(actionView),
      git: { mode, warnings: workshopPushWarnings(mode, warnings) },
      visibleIn,
      report,
    };
    const manifests = applyActions
      .filter((action) => action.manifest && action.content !== undefined)
      .map((action) => ({
        relativePath: action.relativePath,
        ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
        afterHash: hashContent(action.applyContent ?? action.content!),
      }));
    const harnessName = request.harness === "codex" ? "Codex" : "Claude Code";
    plans.set(plan.planId, {
      plan,
      operationId: randomUUID(),
      root: marketplace.root,
      actions: applyActions,
      manifests,
      commitMessage: `Make ${marketplace.name} compatible with ${harnessName}`,
      harness: request.harness,
      sourceId: request.sourceId,
    });
    return { status: "ready", plan };
  };

  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored) return undefined;
    plans.delete(request.planId);
    const backupRoot = join(options.userDataPath, "omni/backups", stored.operationId);
    const merged = stored.actions.filter((action) => action.beforeHash).map((action) => action.relativePath);
    const completed: PlannedAction[] = [];
    try {
      const active = await readRegisteredSource(options.userDataPath, stored.sourceId);
      if (!active || active.root !== stored.root) throw new Error("The approved marketplace target is no longer safe.");
      await backupFiles(stored.root, backupRoot, merged);
      for (const action of stored.actions) {
        if (action.kind === "create-directory") {
          const details = await safeStat(action.absolutePath);
          if (!details) await ensureDirectories(stored.root, action.relativePath);
          else if (!details.isDirectory() || details.isSymbolicLink()) {
            throw new Error("The approved directory changed.");
          }
          completed.push(action);
          continue;
        }
        const current = await readRegularFile(stored.root, action.relativePath);
        if (action.beforeHash && (!current || hashContent(current) !== action.beforeHash)) {
          throw new Error("The approved manifest changed.");
        }
        if (!action.beforeHash && current) {
          throw new Error("The approved manifest destination already exists.");
        }
        const content = action.applyContent ?? action.content ?? "";
        await writeAtomically(stored.root, action.relativePath, content, write);
        const written = await readRegularFile(stored.root, action.relativePath);
        if (!written || hashContent(written) !== hashContent(content)) {
          throw new Error("The written manifest could not be verified.");
        }
        completed.push(action);
      }
      let commit: string | undefined;
      let headBefore: string | undefined;
      let headAfter: string | undefined;
      const writePaths = stored.actions
        .filter((action) => action.kind === "write-file")
        .map((action) => action.relativePath);
      if (stored.plan.git.mode === "commit" && writePaths.length) {
        headBefore = await options.git.headCommit(stored.root);
        const result = await options.git.commitAll(stored.root, stored.commitMessage, writePaths);
        if (result.status !== "committed") throw new Error(result.diagnostic);
        commit = result.commit;
        headAfter = await options.git.headCommit(stored.root);
      }
      const receipt: OperationReceipt = {
        operationId: stored.operationId,
        kind: "make-compatible",
        status: "applied",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        harness: stored.harness,
        actions: stored.actions.map((action) => ({
          ...actionView(action),
          status: "applied" as const,
        })),
        git: {
          mode: stored.plan.git.mode,
          ...(commit ? { commit } : {}),
          ...(headBefore ? { headBefore } : {}),
          ...(headAfter ? { headAfter } : {}),
        },
        registered: { sourceId: stored.sourceId },
        manifests: stored.manifests,
        ...(request.provenance ? { provenance: request.provenance } : {}),
      };
      const delivered = await persistWorkshopReceipt(receipt, stored.root, options);
      return { status: "applied", receipt: delivered };
    } catch (error: unknown) {
      for (const path of merged) await restoreBackup(stored.root, backupRoot, path).catch(() => false);
      for (const action of completed.filter((item) => item.kind === "write-file" && !item.beforeHash)) {
        await removeFileOrEmptyDirectories(stored.root, action.relativePath, ".").catch(() => undefined);
      }
      for (const action of completed.filter((item) => item.kind === "create-directory").reverse()) {
        await removeDirectoryIfEmpty(stored.root, action.relativePath).catch(() => undefined);
      }
      const receipt: OperationReceipt = {
        operationId: stored.operationId,
        kind: "make-compatible",
        status: "failed",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        harness: stored.harness,
        actions: stored.actions.map((action) => ({
          ...actionView(action),
          status: completed.includes(action) ? ("rolled-back" as const) : ("failed" as const),
        })),
        git: { mode: stored.plan.git.mode },
        registered: { sourceId: stored.sourceId },
        ...(request.provenance ? { provenance: request.provenance } : {}),
        diagnostic: error instanceof Error ? error.message : "The compatibility operation failed.",
      };
      await options.operationStore.append(receipt).catch(() => undefined);
      return { status: "failed", receipt };
    }
  };

  return { preview, apply };
}
import { persistWorkshopReceipt } from "./workshop-delivery/receipt";
