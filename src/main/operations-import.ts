import { StorefrontTargetError } from "../domain/source-roles";
import { buildNewPluginProjections, PluginProjectionError } from "./new-plugin-projections";
import { readImportedSkillOrigin } from "./import-skill-origin";
import { parseFrontmatter } from "../adapters/inventory/frontmatter";
import type { SkillCopyProvenance } from "../shared/skill-copy-provenance";
import type { SettingsStore } from "./settings-store";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { createLocalInventoryPort } from "../adapters/inventory/local-filesystem";
import { detectSourceLayout } from "../adapters/inventory/source-layout";
import { visibleIn as visibleInManifests } from "../domain/compatibility";
import type { Harness } from "../domain/harness-projection";
import {
  createPackageManifest,
  parseMarketplaceManifest,
  packageSlugFromPath,
  slugify,
  type MarketplaceArtifactKind,
  type PackageManifest,
} from "../domain/marketplace-format";
import type { ObservedArtifact, ObservedPackage } from "../domain/inventory";
import type { EntryKind } from "../domain/project-source-registry";
import {
  parseApplyOperationRequest,
  type ApplyOperationResponse,
  type OperationAction,
  type OperationPlan,
  type OperationReceipt,
  type PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parsePreviewImportRequest, type ImportArtifactRequest } from "../shared/operations-import-ipc";
import type { RegistryGrantStore } from "./registry-ipc";
import type { OperationStore } from "./operation-store";
import type { GitCli } from "./git-cli";
import { readActiveWorkshop, readRegisteredEntryName } from "./operations-paths";
import {
  hashContent,
  json,
  manifestAction,
  marketplaceManifestBirth,
  packageManifestBirth,
  packageManifests,
  packageMetadata,
  parseObject,
  safeStat,
} from "./marketplace-manifests";
import { readOptionalText } from "./fs-optional";
import {
  within,
  resolveSourcePath,
  assertGrant,
  collectFiles,
  unitKind,
  inspectUnit,
  targetRelative,
  writeAtomic,
  observedLayout,
  block,
  actionView,
} from "./operations-import-plan";
import { parseCatalogueProvenanceMarker } from "./catalogue/cache";

const MAX_BYTES = 1024 * 1024;
const SAFE_WARNING = "The marketplace is inside another repository; Git metadata will not be written.";
type FileWriter = (
  path: string,
  content: string | Uint8Array,
  options: { encoding: "utf8"; mode: number },
) => Promise<void>;
type SourceFile = Readonly<{ relativePath: string; content: Buffer; contentHash: string }>;
type PlannedAction = OperationAction &
  Readonly<{ absolutePath: string; content?: string | Uint8Array; beforeContent?: string; beforeHash?: string }>;
type ManifestReceipt = Readonly<{ relativePath: string; beforeHash?: string; afterHash: string }>;
type StoredPlan = Readonly<{
  plan: OperationPlan;
  operationId: string;
  root: string;
  marketplaceId: string;
  packageRoot: string;
  actions: readonly PlannedAction[];
  source: Readonly<{ kind: EntryKind; id: string; relativePath: string }>;
  manifests: readonly ManifestReceipt[];
  copiedFrom?: SkillCopyProvenance;
  commitMessage: string;
}>;
type ImportOptions = Readonly<{
  userDataPath: string;
  now?: () => number;
  operationStore: OperationStore;
  git: GitCli;
  fileWriter?: FileWriter;
  settingsStore?: SettingsStore;
}>;

export function createImportOperations(
  grants: RegistryGrantStore,
  options: ImportOptions,
): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const now = options.now ?? Date.now;
  const plans = new Map<string, StoredPlan>();
  const write = options.fileWriter ?? ((path, content, writeOptions) => writeFile(path, content, writeOptions));

  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parsePreviewImportRequest(raw);
    let marketplace: Awaited<ReturnType<typeof readActiveWorkshop>>;
    try {
      marketplace = await readActiveWorkshop(options.userDataPath);
    } catch (error) {
      if (error instanceof StorefrontTargetError) return block(error.code, error.message);
      throw error;
    }
    if (!marketplace)
      return block("personal-marketplace-missing", "Register a personal marketplace before importing an artifact.");
    let source: { root: string; sourceName: string };
    try {
      source = await assertGrant(grants, request);
    } catch (error: unknown) {
      return block("source-grant-invalid", error instanceof Error ? error.message : "The source grant is invalid.");
    }
    source = {
      ...source,
      sourceName:
        (await readRegisteredEntryName(options.userDataPath, request.source.kind, request.source.id)) ??
        source.sourceName,
    };
    const catalogueProvenance = parseCatalogueProvenanceMarker(
      (await readOptionalText(join(source.root, ".omni-catalogue-provenance.json"))) ?? "",
    );
    if (catalogueProvenance) source = { ...source, sourceName: `skills.sh: ${catalogueProvenance.ownerRepo}` };
    let inspected: Awaited<ReturnType<typeof inspectUnit>>;
    try {
      inspected = await inspectUnit(source.root, request.relativePath);
    } catch (error: unknown) {
      return block("artifact-unavailable", error instanceof Error ? error.message : "The artifact is unavailable.");
    }

    if (inspected.unit.kind === "skill") {
      const markdown = inspected.files.find((file) => file.relativePath.endsWith("/SKILL.md"));
      const name = markdown && parseFrontmatter(markdown.content.toString("utf8"), true).name;
      if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
        return block("invalid-skill-name", "The skill name must use lowercase letters and hyphens.");
      if (name) inspected = { ...inspected, unit: { ...inspected.unit, id: name } };
    }
    let copiedFrom: SkillCopyProvenance | undefined;
    try {
      copiedFrom =
        request.source.kind === "project" && inspected.unit.kind === "skill"
          ? await readImportedSkillOrigin(source.root, inspected.unit.sourceRelative)
          : undefined;
    } catch {
      return block(
        "skill-origin-unavailable",
        "The project origin cannot be read safely. Refresh the project before copying.",
      );
    }
    const isNewPackage = "newPackageName" in request.target;
    let packagePath = isNewPackage ? "packages/" + slugify(request.target.newPackageName) : request.target.packageId;
    const packageId = packageSlugFromPath(packagePath);
    if (!packageId || (isNewPackage && !slugify(request.target.newPackageName)))
      return block("invalid-package-name", "Choose a package name that produces a safe slug.");
    let packageRoot = join(marketplace.root, packagePath);
    if (!within(marketplace.root, resolve(packageRoot)))
      return block("package-unsafe", "The selected package is outside the personal marketplace.");
    let packageDetails = await safeStat(packageRoot);
    if (!isNewPackage && !packageDetails && !packagePath.includes("/")) {
      const legacyPath = "packages/" + packagePath;
      const legacyRoot = join(marketplace.root, legacyPath);
      const legacyDetails = await safeStat(legacyRoot);
      if (legacyDetails) {
        packagePath = legacyPath;
        packageRoot = legacyRoot;
        packageDetails = legacyDetails;
      }
    }
    if (!isNewPackage && !packageDetails)
      return block("package-missing", "The selected observed package does not exist.");
    if (isNewPackage && packageDetails) return block("package-exists", "The new package destination already exists.");
    if (packageDetails && (!packageDetails.isDirectory() || packageDetails.isSymbolicLink()))
      return block("package-invalid", "The selected package is not a regular directory.");

    const layout = isNewPackage ? undefined : await observedLayout(marketplace.root);
    const observed = layout?.packages?.find((item) => item.relativeRoot === packagePath);
    if (!isNewPackage && !observed) return block("package-unobserved", "The selected package is no longer observed.");
    const metadata = isNewPackage
      ? {
          name: request.target.newPackageName.trim(),
          description: request.target.description,
          artifacts: [] as readonly { kind: MarketplaceArtifactKind; path: string }[],
        }
      : await packageMetadata(marketplace.root, packagePath, layout?.artifacts);
    const existingPackageContent = await readOptionalText(join(packageRoot, "omni.plugin.json"));
    let packageManifest: PackageManifest;
    try {
      packageManifest = (await packageManifestBirth(marketplace.root, packagePath, metadata)).manifest;
    } catch {
      return block("package-manifest-invalid", "The selected Omni package manifest is invalid.");
    }
    const artifactPath = targetRelative(inspected.unit.kind, inspected.unit.id, inspected.unit.sourceRelative);
    if (await safeStat(join(packageRoot, artifactPath)))
      return block("duplicate-logical-id", "The target plugin already contains a skill with this name.");
    if (
      packageManifest.artifacts.some(
        (artifact) => artifact.kind === inspected.unit.kind && packageSlugFromPath(artifact.path) === inspected.unit.id,
      )
    )
      return block("duplicate-logical-id", "The target package already contains this artifact.");

    let marketplaceManifest: ReturnType<typeof parseMarketplaceManifest>;
    const marketplacePath = "omni.marketplace.json";
    const marketplaceBefore = await readOptionalText(join(marketplace.root, marketplacePath));
    if (marketplaceBefore) {
      try {
        marketplaceManifest = parseMarketplaceManifest(parseObject(marketplaceBefore));
      } catch {
        return block("marketplace-manifest-invalid", "The Omni marketplace manifest is invalid.");
      }
    } else {
      try {
        marketplaceManifest = (await marketplaceManifestBirth(marketplace.root, now())).manifest;
      } catch {
        return block("marketplace-manifest-invalid", "The Omni marketplace manifest is invalid.");
      }
    }
    for (const item of await packageManifests(marketplace.root, marketplaceManifest.packages)) {
      for (const artifact of item.manifest.artifacts) {
        if (
          item.manifest.provenance?.importedFrom?.contentHash === inspected.contentHash ||
          artifact.provenance?.contentHash === inspected.contentHash
        )
          return block("duplicate-content-hash", "This artifact content already exists in the marketplace.");
        const existingPath = resolve(marketplace.root, item.path, artifact.path);
        const existingDetails = await safeStat(existingPath);
        if (existingDetails?.isFile() && hashContent(await readFile(existingPath)) === inspected.contentHash)
          return block("duplicate-content-hash", "This artifact content already exists in the marketplace.");
        if (existingDetails?.isDirectory() && within(marketplace.root, existingPath)) {
          const existingFiles = await collectFiles(existingPath, marketplace.root, item.path + "/" + artifact.path);
          const prefix = item.path.length + artifact.path.length + 2;
          const lines = existingFiles.map((file) => file.relativePath.slice(prefix) + ":" + file.contentHash).sort();
          if (hashContent(Buffer.from(lines.join("\n"), "utf8")) === inspected.contentHash)
            return block("duplicate-content-hash", "This artifact content already exists in the marketplace.");
        }
      }
    }

    const importedAt = new Date(now()).toISOString();
    const nextPackage = createPackageManifest({
      ...packageManifest,
      artifacts: [
        ...packageManifest.artifacts,
        {
          kind: inspected.unit.kind,
          path: artifactPath,
          provenance: {
            ...(copiedFrom ?? {
              source: catalogueProvenance?.ownerRepo ?? source.sourceName,
              skillPath: request.relativePath,
              computedHash: inspected.contentHash,
            }),
            relativePath: request.relativePath,
            contentHash: inspected.contentHash,
            importedAt,
            ...(request.source.kind === "project"
              ? { project: { id: request.source.id, name: source.sourceName } }
              : {}),
            ...(catalogueProvenance
              ? {
                  reason: `Imported from skills.sh (${catalogueProvenance.ownerRepo}/${catalogueProvenance.skill}): ${catalogueProvenance.url} · sha256:${catalogueProvenance.hash}`,
                }
              : {}),
          },
        },
      ],
    });
    const packageEntryPath = marketplaceManifest.packages.some((entry) => entry.path === packagePath)
      ? marketplaceManifest.packages
      : [...marketplaceManifest.packages, { path: packagePath }];
    const nextMarketplace = { ...marketplaceManifest, packages: packageEntryPath };
    const actions: PlannedAction[] = [];
    const destinations = inspected.files.map((file) => ({
      file,
      relativePath:
        packagePath +
        "/" +
        (inspected.unit.folder
          ? artifactPath + "/" + file.relativePath.slice(inspected.unit.sourceRelative.length + 1)
          : artifactPath),
    }));
    const directories = new Set<string>();
    if (isNewPackage) {
      directories.add("packages");
      directories.add(packagePath);
    }
    for (const destination of destinations) {
      let current = dirname(destination.relativePath);
      while (current && current !== ".") {
        directories.add(current);
        current = dirname(current);
      }
    }

    let projectionManifests: readonly PlannedAction[] = [];
    if (isNewPackage) {
      try {
        projectionManifests = await buildNewPluginProjections(
          marketplace.root,
          packagePath,
          nextPackage,
          request.target.projectTo,
        );
      } catch (error) {
        return block(
          error instanceof PluginProjectionError ? error.reason : "harness-marketplace-invalid",
          error instanceof Error ? error.message : "The agent marketplace is invalid.",
        );
      }
      for (const action of projectionManifests) directories.add(dirname(action.relativePath));
    }
    for (const directory of [...directories].sort(
      (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
    )) {
      const details = await safeStat(join(marketplace.root, directory));
      if (details && (!details.isDirectory() || details.isSymbolicLink()))
        return block("target-unsafe", "The marketplace destination contains an unsafe directory.");
      if (!details)
        actions.push({
          kind: "create-directory",
          relativePath: directory,
          absolutePath: join(marketplace.root, directory),
        });
    }
    for (const destination of destinations)
      actions.push({
        kind: "write-file",
        relativePath: destination.relativePath,
        byteLength: destination.file.content.byteLength,
        absolutePath: join(marketplace.root, destination.relativePath),
        content: destination.file.content,
      });
    const packageRelativePath = packagePath + "/omni.plugin.json";
    const nextPackageContent = json(nextPackage);
    actions.push(manifestAction(marketplace.root, packageRelativePath, nextPackageContent, existingPackageContent));
    const nextMarketplaceContent = json(nextMarketplace);
    actions.push(manifestAction(marketplace.root, marketplacePath, nextMarketplaceContent, marketplaceBefore));
    actions.push(...projectionManifests);

    const mode =
      options.settingsStore && !(await options.settingsStore.read()).git.commitChanges
        ? ("disabled" as const)
        : !(await options.git.isGitAvailable())
          ? ("unavailable" as const)
          : (await options.git.isRepositoryRoot(marketplace.root))
            ? ("commit" as const)
            : ("enclosing-repository" as const);
    const warnings =
      mode === "enclosing-repository"
        ? [SAFE_WARNING]
        : mode === "unavailable"
          ? ["Git is unavailable; the marketplace files will still be written."]
          : [];
    const observedHarnesses = observed
      ? visibleInManifests(observed).filter((item): item is Harness => item === "claude-code" || item === "codex")
      : [];
    const visibleIn = [
      "omni" as const,
      ...(isNewPackage
        ? projectionManifests
            .filter((action) => action.relativePath.endsWith("/plugin.json"))
            .map((action): Harness => (action.relativePath.includes("/.claude-plugin/") ? "claude-code" : "codex"))
        : observedHarnesses),
    ];
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "import-artifact",
      displayTarget: packagePath,
      actions: actions.map(actionView),
      git: { mode, warnings },
      visibleIn,
      ...(isNewPackage
        ? { notes: [`New plugin ${request.target.newPackageName}: ${request.target.description}`] }
        : {}),
      ...(copiedFrom
        ? {
            notes: [
              `Copied from ${copiedFrom.source}${copiedFrom.ref ? ` at ${copiedFrom.ref}` : ""}${copiedFrom.skillPath ? ` (${copiedFrom.skillPath})` : ""}; the project keeps its external version.`,
            ],
          }
        : {}),
    };
    const manifests: ManifestReceipt[] = actions
      .filter((action) => action.manifest)
      .map((action) => ({
        relativePath: action.relativePath,
        ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
        afterHash: hashContent(action.content as string),
      }));
    plans.set(plan.planId, {
      plan,
      operationId: randomUUID(),
      root: marketplace.root,
      marketplaceId: marketplace.id,
      packageRoot,
      actions,
      source: { kind: request.source.kind, id: request.source.id, relativePath: request.relativePath },
      manifests,
      ...(copiedFrom ? { copiedFrom } : {}),
      commitMessage: `Import ${inspected.unit.id} into ${basename(packageRoot)}`,
    });
    return { status: "ready", plan };
  };

  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored) return undefined;
    plans.delete(request.planId);
    const applied: PlannedAction[] = [];
    const modifiedManifests: PlannedAction[] = [];
    const createdDirectories: string[] = [];
    const backupRoot = join(options.userDataPath, "omni", "backups", stored.operationId);
    try {
      const active = await readActiveWorkshop(options.userDataPath);
      if (!active || active.root !== stored.root || !within(active.root, stored.packageRoot))
        throw new Error("The approved marketplace target is no longer safe.");
      for (const action of stored.actions) {
        if (action.kind === "create-directory") {
          const details = await safeStat(action.absolutePath);
          if (details && (!details.isDirectory() || details.isSymbolicLink()))
            throw new Error("The approved directory changed.");
          if (!details) {
            await mkdir(action.absolutePath);
            await chmod(action.absolutePath, 0o755);
            createdDirectories.push(action.absolutePath);
          }
          continue;
        }
        const existing = await safeStat(action.absolutePath);
        if (!action.manifest && existing) throw new Error("The approved artifact destination already exists.");
        if (
          action.manifest &&
          action.beforeHash &&
          hashContent(await readFile(action.absolutePath, "utf8")) !== action.beforeHash
        )
          throw new Error("The approved manifest changed.");
        if (action.manifest && !action.beforeHash && existing)
          throw new Error("The approved manifest destination already exists.");
        if (action.manifest && action.beforeContent !== undefined) {
          await mkdir(dirname(join(backupRoot, action.relativePath)), { recursive: true });
          await writeFile(join(backupRoot, action.relativePath), action.beforeContent, {
            encoding: "utf8",
            mode: 0o644,
          });
          modifiedManifests.push(action);
        }
        await writeAtomic(action.absolutePath, action.content ?? "", write);
        applied.push(action);
      }
      let commit: string | undefined;
      if (stored.plan.git.mode === "commit") {
        const result = await options.git.commitAll(
          stored.root,
          stored.commitMessage,
          stored.actions.filter((action) => action.kind === "write-file").map((action) => action.relativePath),
        );
        if (result.status !== "committed") throw new Error(result.diagnostic);
        commit = result.commit;
      }
      const receipt: OperationReceipt = {
        operationId: stored.operationId,
        kind: "import-artifact",
        status: "applied",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        actions: stored.actions.map((action) => ({ ...actionView(action), status: "applied" as const })),
        git: { mode: stored.plan.git.mode, ...(commit ? { commit } : {}) },
        registered: { sourceId: stored.marketplaceId },
        source: stored.source,
        ...(request.provenance || stored.copiedFrom
          ? {
              provenance: {
                ...request.provenance,
                ...(stored.copiedFrom
                  ? {
                      copiedFrom: stored.copiedFrom,
                      reason: `Copied from ${stored.copiedFrom.source}${stored.copiedFrom.ref ? ` at ${stored.copiedFrom.ref}` : ""}${stored.copiedFrom.skillPath ? ` (${stored.copiedFrom.skillPath})` : ""}.`,
                    }
                  : {}),
              },
            }
          : {}),
        files: stored.actions
          .filter((action) => action.kind === "write-file" && !action.manifest)
          .map((action) => ({
            relativePath: action.relativePath,
            contentHash: hashContent(action.content as Uint8Array),
          })),
        manifests: stored.manifests,
      };
      const persisted = await options.operationStore.append(receipt);
      if (persisted.status !== "ready") throw new Error("The import receipt could not be persisted safely.");
      return { status: "applied", receipt };
    } catch (error: unknown) {
      for (const action of modifiedManifests.reverse())
        if (action.beforeContent !== undefined)
          await writeFile(action.absolutePath, action.beforeContent, "utf8").catch(() => undefined);
      await Promise.all(
        applied
          .filter((action) => action.kind === "write-file" && !action.manifest)
          .map((action) => unlink(action.absolutePath).catch(() => undefined)),
      );
      await Promise.all(
        applied
          .filter((action) => action.kind === "write-file" && action.manifest && action.beforeContent === undefined)
          .map((action) => unlink(action.absolutePath).catch(() => undefined)),
      );
      for (const directory of createdDirectories.reverse()) await rm(directory, { recursive: true, force: true });
      const receipt: OperationReceipt = {
        operationId: stored.operationId,
        kind: "import-artifact",
        status: "failed",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        actions: stored.actions.map((action) => ({
          ...actionView(action),
          status: applied.some((done) => done.absolutePath === action.absolutePath)
            ? ("rolled-back" as const)
            : ("failed" as const),
        })),
        git: { mode: stored.plan.git.mode },
        registered: { sourceId: stored.marketplaceId },
        source: stored.source,
        ...(request.provenance || stored.copiedFrom
          ? {
              provenance: {
                ...request.provenance,
                ...(stored.copiedFrom
                  ? {
                      copiedFrom: stored.copiedFrom,
                      reason: `Copied from ${stored.copiedFrom.source}${stored.copiedFrom.ref ? ` at ${stored.copiedFrom.ref}` : ""}${stored.copiedFrom.skillPath ? ` (${stored.copiedFrom.skillPath})` : ""}.`,
                    }
                  : {}),
              },
            }
          : {}),
      };
      await options.operationStore.append(receipt).catch(() => undefined);
      void error;
      return { status: "failed", receipt };
    }
  };

  return { preview, apply };
}
