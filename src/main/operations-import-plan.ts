import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { createLocalInventoryPort } from "../adapters/inventory/local-filesystem";
import { detectSourceLayout } from "../adapters/inventory/source-layout";
import { visibleIn as visibleInManifests } from "../domain/compatibility";
import { projectMarketplaceEntry, projectPluginManifest, type Harness } from "../domain/harness-projection";
import {
  createPackageManifest,
  parseMarketplaceManifest,
  packageSlugFromPath,
  slugify,
  type MarketplaceArtifactKind,
  type PackageManifest,
} from "../domain/marketplace-format";
import type { ObservedArtifact } from "../domain/inventory";
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
  harnessMarketplaces,
  hashContent,
  indentationOf,
  json,
  manifestAction,
  marketplaceManifestBirth,
  packageManifestBirth,
  packageManifests,
  packageMetadata,
  parseObject,
  safeStat,
} from "./marketplace-manifests";

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
  packageRoot: string;
  actions: readonly PlannedAction[];
  source: Readonly<{ kind: EntryKind; id: string; relativePath: string }>;
  manifests: readonly ManifestReceipt[];
  commitMessage: string;
}>;
type ImportOptions = Readonly<{
  userDataPath: string;
  now?: () => number;
  operationStore: OperationStore;
  git: GitCli;
  fileWriter?: FileWriter;
}>;

export function within(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === "" || (distance !== ".." && !distance.startsWith(".." + sep) && !distance.startsWith(sep));
}

export async function resolveSourcePath(root: string, path: string): Promise<string> {
  const lexical = resolve(root, path.replaceAll("\\", sep));
  if (!within(root, lexical)) throw new Error("The artifact path escapes the observed root.");
  const canonical = await realpath(lexical);
  if (!within(root, canonical)) throw new Error("The artifact path escapes the observed root.");
  return canonical;
}

export async function assertGrant(
  grants: RegistryGrantStore,
  request: ImportArtifactRequest,
): Promise<{ root: string; sourceName: string }> {
  const grant = grants.get(request.source.grantHandle);
  if (!grant || grant.subject.kind !== request.source.kind || grant.subject.id !== request.source.id)
    throw new Error("The source grant does not match the requested entry.");
  const canonical = await realpath(grant.root);
  const details = await stat(canonical);
  if (
    canonical !== grant.root ||
    !details.isDirectory() ||
    String(details.dev) !== grant.device ||
    String(details.ino) !== grant.inode
  )
    throw new Error("The observed root changed since it was opened.");
  return { root: canonical, sourceName: grant.displayName ?? (basename(canonical) || request.source.id) };
}

export async function collectFiles(
  path: string,
  root: string,
  relativeRoot: string,
  seen = new Set<string>(),
): Promise<SourceFile[]> {
  const canonical = await realpath(path);
  if (!within(root, canonical)) throw new Error("The artifact contains a path outside the observed root.");
  const details = await stat(canonical);
  if (details.isDirectory()) {
    if (seen.has(canonical)) return [];
    seen.add(canonical);
    const files: SourceFile[] = [];
    for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name !== ".git")
        files.push(...(await collectFiles(join(canonical, entry.name), root, relativeRoot + "/" + entry.name, seen)));
    }
    return files;
  }
  if (!details.isFile() || details.size > MAX_BYTES)
    throw new Error("The artifact contains a file over the 1 MiB limit.");
  const content = await readFile(canonical);
  if (content.byteLength > MAX_BYTES) throw new Error("The artifact contains a file over the 1 MiB limit.");
  return [{ relativePath: relativeRoot, content, contentHash: hashContent(content) }];
}

export function unitKind(
  relativePath: string,
  isDirectory: boolean,
  hasSkill: boolean,
): { kind: MarketplaceArtifactKind; id: string; folder: boolean; sourceRelative: string } {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const skillIndex = parts.lastIndexOf("skills");
  if (hasSkill || (parts.at(-1) === "SKILL.md" && skillIndex >= 0)) {
    const id = parts[skillIndex + 1] || basename(dirname(normalized));
    return { kind: "skill", id, folder: true, sourceRelative: parts.slice(0, skillIndex + 2).join("/") };
  }
  const hookIndex = parts.lastIndexOf("hooks");
  if (hookIndex >= 0 && parts[hookIndex + 1]) {
    const id = parts[hookIndex + 1]!;
    return { kind: "hook", id, folder: true, sourceRelative: parts.slice(0, hookIndex + 2).join("/") };
  }
  const file = basename(normalized);
  const id = file.replace(new RegExp(extname(file) + "$"), "");
  const parent = parts.at(-2);
  const kind: MarketplaceArtifactKind =
    parent === "commands" ? "command" : parent === "agents" ? "agent" : parent === "mcp" ? "mcp-config" : "instruction";
  return { kind, id, folder: isDirectory, sourceRelative: normalized };
}

export async function inspectUnit(
  root: string,
  requestedPath: string,
): Promise<{ unit: ReturnType<typeof unitKind>; files: readonly SourceFile[]; contentHash: string }> {
  const resolved = await resolveSourcePath(root, requestedPath);
  const details = await stat(resolved);
  let unitPath = resolved;
  let unitRelative = requestedPath.replaceAll("\\", "/");
  let hasSkill = false;
  if (details.isDirectory()) {
    try {
      hasSkill = (await stat(join(resolved, "SKILL.md"))).isFile();
    } catch {
      hasSkill = false;
    }
  } else if (basename(resolved) === "SKILL.md") {
    unitPath = dirname(resolved);
    unitRelative = dirname(unitRelative).replaceAll("\\", "/");
    hasSkill = true;
  } else {
    const parts = requestedPath.replaceAll("\\", "/").split("/");
    const hookIndex = parts.lastIndexOf("hooks");
    if (hookIndex >= 0 && parts[hookIndex + 1]) {
      unitPath = await resolveSourcePath(root, parts.slice(0, hookIndex + 2).join("/"));
      unitRelative = parts.slice(0, hookIndex + 2).join("/");
    }
  }
  const unit = unitKind(unitRelative, details.isDirectory(), hasSkill);
  if (details.isDirectory() && !hasSkill && unit.kind !== "hook")
    throw new Error("Only skill and hook folders can be imported as directories.");
  const files = await collectFiles(unitPath, root, unitRelative);
  if (!files.length) throw new Error("The selected artifact is unavailable.");
  if (!unit.folder) return { unit, files, contentHash: files[0]!.contentHash };
  const lines = files.map((file) => file.relativePath.slice(unitRelative.length + 1) + ":" + file.contentHash).sort();
  return { unit, files, contentHash: hashContent(Buffer.from(lines.join("\n"), "utf8")) };
}

export function targetRelative(kind: MarketplaceArtifactKind, id: string, sourceRelative: string): string {
  if (kind === "skill" || kind === "hook") return (kind === "skill" ? "skills/" : "hooks/") + id;
  const tree =
    kind === "command" ? "commands" : kind === "agent" ? "agents" : kind === "mcp-config" ? "mcp" : "instructions";
  return tree + "/" + id + (extname(sourceRelative) || (kind === "mcp-config" ? ".json" : ".md"));
}

export async function writeAtomic(path: string, content: string | Uint8Array, writer: FileWriter): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writer(temporary, content, { encoding: "utf8", mode: 0o644 });
    await chmod(temporary, 0o644);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

// One layout detection per operation; callers pick the package and keep the artifacts.
export async function observedLayout(root: string): Promise<Awaited<ReturnType<typeof detectSourceLayout>>> {
  return detectSourceLayout(createLocalInventoryPort(root), "source");
}

export function block(reason: string, diagnostic: string): PreviewMarketplaceResponse {
  return { status: "blocked", reason, diagnostic };
}

export function actionView(action: PlannedAction): OperationAction {
  return {
    kind: action.kind,
    relativePath: action.relativePath,
    ...(action.byteLength === undefined ? {} : { byteLength: action.byteLength }),
    ...(action.manifest === undefined ? {} : { manifest: action.manifest }),
  };
}
