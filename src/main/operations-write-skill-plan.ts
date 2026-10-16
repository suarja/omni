import { resolveObservedPackage } from "../domain/observed-package-resolution";
import { buildNewPluginProjections } from "./new-plugin-projections";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createUnifiedDiff } from "../domain/unified-diff";
import type { SkillCheckFile } from "../domain/skill-checks";
import { createPackageManifest, type PackageManifest } from "../domain/marketplace-format";
import type { ObservedArtifact, ObservedPackage } from "../domain/inventory";
import type { OperationAction, OperationPlan } from "../shared/operations-ipc";
import type { WriteSkillRequest } from "../shared/operations-write-skill-ipc";
import { writeSkillFileBytes, writeSkillFileText } from "../shared/operations-write-skill-ipc";
import {
  addDirectories,
  hashContent,
  json,
  manifestAction,
  marketplaceManifestBirth,
  packageManifestBirth,
  packageMetadata,
  safeStat,
} from "./marketplace-manifests";
import { manifestUpdate } from "./marketplace-manifest-merge";
import { readRegularFile } from "./operation-files";
import { readOptionalText } from "./fs-optional";

export type SkillPlannedAction = OperationAction &
  Readonly<{
    absolutePath: string;
    content?: string | Uint8Array;
    beforeContent?: string | Uint8Array;
    beforeHash?: string;
  }>;
export type SkillManifestReceipt = Readonly<{ relativePath: string; beforeHash?: string; afterHash: string }>;
export type SkillPlanBuild = Readonly<{
  plan: OperationPlan;
  actions: readonly SkillPlannedAction[];
  manifests: readonly SkillManifestReceipt[];
  packageRoot: string;
  skillRoot: string;
  commitMessage: string;
}>;

function actionView(action: SkillPlannedAction): OperationAction {
  return {
    kind: action.kind,
    relativePath: action.relativePath,
    ...(action.byteLength === undefined ? {} : { byteLength: action.byteLength }),
    ...(action.beforeHash === undefined ? {} : { beforeHash: action.beforeHash }),
    ...(action.content === undefined ? {} : { afterHash: hashContent(action.content) }),
    ...(action.manifest === undefined ? {} : { manifest: action.manifest }),
    ...(action.diff === undefined ? {} : { diff: action.diff }),
  };
}

function provenanceManifest(manifest: PackageManifest, request: WriteSkillRequest): Record<string, unknown> {
  const value = JSON.parse(json(manifest)) as Record<string, unknown>;
  if (request.agent || request.reason) {
    value.provenance = {
      ...(manifest.provenance ?? {}),
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
    };
  }
  return value;
}

function skillNames(
  artifacts: readonly ObservedArtifact[],
  current: string,
  excludeCurrent = false,
): readonly string[] {
  return artifacts
    .filter((artifact) => artifact.kind === "skill")
    .map((artifact) => artifact.relativePath.match(/(?:^|\/)skills\/([^/]+)\//u)?.[1] ?? artifact.id)
    .filter((name) => !excludeCurrent || name.toLowerCase() !== current.toLowerCase());
}

function gitMode(mode: "commit" | "enclosing-repository" | "unavailable"): OperationPlan["git"] {
  return {
    mode,
    warnings:
      mode === "enclosing-repository"
        ? ["The marketplace is inside another repository; Git metadata will not be written."]
        : mode === "unavailable"
          ? ["Git is unavailable; the skill files will still be written."]
          : [],
  };
}

export async function buildWriteSkillPlan(
  args: Readonly<{
    root: string;
    packageId?: string;
    request: WriteSkillRequest;
    packages: readonly ObservedPackage[];
    artifacts: readonly ObservedArtifact[];
    findings: OperationPlan["findings"];
    now: number;
    git: OperationPlan["git"];
  }>,
): Promise<SkillPlanBuild | Readonly<{ blocked: string }>> {
  const newPackage = args.request.newPackage;
  const resolution = newPackage ? undefined : resolveObservedPackage(args.packages, args.packageId!);
  if (resolution?.status === "blocked") return { blocked: resolution.message };
  const packageInfo = newPackage
    ? { relativeRoot: `packages/${newPackage.name}` }
    : resolution?.status === "resolved"
      ? resolution.package
      : undefined;
  if (!packageInfo) return { blocked: "The selected observed package does not exist." };
  const packageRoot = join(args.root, packageInfo.relativeRoot);
  if (newPackage && (await safeStat(packageRoot))) return { blocked: "The new plugin destination already exists." };
  const skillRoot = `${packageInfo.relativeRoot}/skills/${args.request.folderName}`;
  const skillAbsolute = join(args.root, skillRoot);
  const skillDetails = await safeStat(skillAbsolute);
  if (skillDetails && (!skillDetails.isDirectory() || skillDetails.isSymbolicLink()))
    return { blocked: "The selected skill folder is not a regular directory." };
  if (args.request.mode === "create" && skillDetails)
    return { blocked: "The skill folder already exists; choose update mode." };
  if (args.request.mode === "update" && !skillDetails)
    return { blocked: "The skill folder does not exist; choose create mode." };

  const metadata = newPackage
    ? { ...newPackage, artifacts: [] }
    : await packageMetadata(args.root, packageInfo.relativeRoot, args.artifacts);
  const packageBirth = await packageManifestBirth(args.root, packageInfo.relativeRoot, metadata);
  const packageManifest = createPackageManifest({
    ...packageBirth.manifest,
    artifacts: [
      ...packageBirth.manifest.artifacts.filter((artifact) => artifact.path !== `skills/${args.request.folderName}`),
      packageBirth.manifest.artifacts.find(
        (artifact) => artifact.kind === "skill" && artifact.path === `skills/${args.request.folderName}`,
      ) ?? { kind: "skill", path: `skills/${args.request.folderName}` },
    ],
  });
  const packageContent = json(provenanceManifest(packageManifest, args.request));
  const actions: SkillPlannedAction[] = [];
  const requestRelative = new Set(args.request.files.map((file) => `${skillRoot}/${file.path}`));
  const existingFiles = skillDetails ? await listSkillFiles(args.root, skillRoot) : [];
  const currentFiles = new Map<string, Uint8Array>();
  for (const relativePath of existingFiles) {
    const content = await readRegularFile(args.root, relativePath);
    if (content !== undefined) currentFiles.set(relativePath, Uint8Array.from(content));
  }
  for (const file of args.request.files) {
    const relativePath = `${skillRoot}/${file.path}`;
    const before = currentFiles.get(relativePath);
    const next = writeSkillFileBytes(file);
    if (args.request.mode === "update" && before && Buffer.from(before).equals(Buffer.from(next))) continue;
    const beforeText = before === undefined ? "" : decodeUtf8(before);
    const nextText = writeSkillFileText(file);
    actions.push({
      kind: "write-file",
      relativePath,
      byteLength: next.byteLength,
      absolutePath: join(args.root, relativePath),
      content: next,
      ...(before === undefined ? {} : { beforeContent: before, beforeHash: hashContent(before) }),
      diff:
        beforeText !== undefined && nextText !== undefined
          ? createUnifiedDiff(
              `${relativePath} (${before === undefined ? "absent" : "current"})`,
              `${relativePath} (proposed)`,
              beforeText,
              nextText,
            ).text
          : `${relativePath}: binary content ${before === undefined ? "added" : "updated"} (${next.byteLength} bytes).`,
    });
  }
  if (args.request.mode === "update" && args.request.replaceFolder) {
    for (const relativePath of existingFiles) {
      if (requestRelative.has(relativePath)) continue;
      const before = currentFiles.get(relativePath);
      if (before === undefined) continue;
      actions.push({
        kind: "delete-file",
        relativePath,
        absolutePath: join(args.root, relativePath),
        beforeContent: before,
        beforeHash: hashContent(before),
        diff:
          decodeUtf8(before) === undefined
            ? `${relativePath}: binary content deleted (${before.byteLength} bytes).`
            : createUnifiedDiff(`${relativePath} (current)`, `${relativePath} (deleted)`, decodeUtf8(before)!, "").text,
      });
    }
  }
  if (newPackage) {
    try {
      actions.push(...(await buildNewPluginProjections(args.root, packageInfo.relativeRoot, packageManifest)));
    } catch (error) {
      return { blocked: error instanceof Error ? error.message : "The agent marketplace is invalid." };
    }
  }
  const directories = addDirectories(
    args.root,
    actions.map((action) => action.relativePath),
  );
  for (const directory of [
    { kind: "create-directory" as const, relativePath: skillRoot, absolutePath: skillAbsolute },
    ...directories,
  ]) {
    const details = await safeStat(directory.absolutePath);
    if (!details) actions.unshift(directory);
    else if (!details.isDirectory() || details.isSymbolicLink())
      return { blocked: "The skill destination contains an unsafe directory." };
  }

  if (packageBirth.beforeContent !== packageContent)
    actions.push(manifestAction(args.root, packageBirth.relativePath, packageContent, packageBirth.beforeContent));
  const marketplacePath = "omni.marketplace.json";
  const marketplaceBefore = await readOptionalText(join(args.root, marketplacePath));
  const marketplace = await marketplaceManifestBirth(args.root, args.now);
  const hasPackage = marketplace.manifest.packages.some((entry) => entry.path === packageInfo.relativeRoot);
  if (!hasPackage) {
    const nextMarketplace = {
      ...marketplace.manifest,
      packages: [...marketplace.manifest.packages, { path: packageInfo.relativeRoot }],
    };
    actions.push(manifestAction(args.root, marketplacePath, json(nextMarketplace), marketplaceBefore));
  } else if (!marketplaceBefore) {
    actions.push(manifestAction(args.root, marketplacePath, marketplace.content));
  }
  const codexPath = `${packageInfo.relativeRoot}/.codex-plugin/plugin.json`;
  const codex = await readOptionalText(join(args.root, codexPath));
  if (codex) {
    const update = await manifestUpdate(args.root, codexPath, { skills: "./skills/" }, new Set([codexPath]));
    if (update) actions.push(update);
  }
  const plan: OperationPlan = {
    planId: randomUUID(),
    kind: "write-skill",
    displayTarget: packageInfo.relativeRoot,
    packageId: newPackage ? `packages/${newPackage.name}` : args.packageId,
    actions: actions.map(actionView),
    git: args.git,
    ...(args.findings?.length ? { findings: args.findings } : {}),
    visibleIn: ["omni", "claude-code", "codex"],
    ...(newPackage ? { notes: [`New plugin ${newPackage.name}: ${newPackage.description}`] } : {}),
  };
  const manifests = actions
    .filter((action) => action.manifest && action.content !== undefined)
    .map((action) => ({
      relativePath: action.relativePath,
      ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
      afterHash: hashContent(action.content!),
    }));
  const agentLabel = args.request.agent
    ? ` via ${args.request.agent.harness === "codex" ? "Codex" : "Claude Code"}`
    : "";
  return {
    plan,
    actions,
    manifests,
    packageRoot,
    skillRoot,
    commitMessage: `${args.request.mode === "create" ? "Add" : "Update"} skill ${args.request.folderName} to ${packageInfo.relativeRoot.split("/").at(-1)}${agentLabel}`,
  };
}

export async function buildSkillCheckProjection(
  args: Readonly<{
    root: string;
    skillRoot: string;
    mode: WriteSkillRequest["mode"];
    replaceFolder?: boolean;
    files: WriteSkillRequest["files"];
  }>,
): Promise<readonly SkillCheckFile[]> {
  const projected = new Map<string, string>();
  if (args.mode === "update" && !args.replaceFolder) {
    const paths = await listSkillFiles(args.root, args.skillRoot);
    if (paths.length > 512) throw new Error("The current skill tree exceeds the file observation limit.");
    let totalBytes = 0;
    for (const path of paths) {
      const bytes = await readRegularFile(args.root, path);
      if (!bytes || bytes.byteLength > 1024 * 1024) throw new Error(`The current skill file is unavailable: ${path}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > 32 * 1024 * 1024) throw new Error("The current skill tree exceeds the byte observation limit.");
      projected.set(path.slice(args.skillRoot.length + 1), decodeUtf8(bytes) ?? "");
    }
  }
  for (const file of args.files) projected.set(file.path, writeSkillFileText(file) ?? "");
  return [...projected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({ path, content }));
}

async function listSkillFiles(root: string, skillRoot: string): Promise<readonly string[]> {
  const { listRegularFiles } = await import("./operation-files");
  return listRegularFiles(root, skillRoot);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const text = Buffer.from(bytes).toString("utf8");
  return Buffer.from(text, "utf8").equals(Buffer.from(bytes)) ? text : undefined;
}

export { gitMode, skillNames };
