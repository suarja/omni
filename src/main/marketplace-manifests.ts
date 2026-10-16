import { lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type { Harness } from "../domain/harness-projection";
import { createUnifiedDiff } from "../domain/unified-diff";
import type { InventorySnapshot, ObservedArtifact } from "../domain/inventory";
import {
  createMarketplaceManifest,
  createPackageManifest,
  parseMarketplaceManifest,
  parsePackageManifest,
  packageSlugFromPath,
  slugify,
  type MarketplaceArtifactKind,
  type MarketplaceManifest,
  type PackageManifest,
} from "../domain/marketplace-format";
import type { OperationAction } from "../shared/operations-ipc";
import { isMissing, readOptionalText } from "./fs-optional";

export type HarnessMarketplace = Readonly<{
  harness: Harness;
  relativePath: string;
  content: string;
  manifest: Record<string, unknown>;
}>;

export type ManifestAction = OperationAction &
  Readonly<{
    absolutePath: string;
    content: string;
    applyContent?: string;
    beforeContent?: string;
    beforeHash?: string;
    apply?: boolean;
  }>;

export async function safeStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export function parseObject(content: string): Record<string, unknown> {
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Manifest must be an object.");
  }
  return value as Record<string, unknown>;
}

type JsonStyle = Readonly<{ indentation: number; inlineArrays: boolean }>;

// Hand-maintained manifests often keep short arrays of primitives on one line
// (`"keywords": ["writing", "editing"]`); a merge must not reflow them into a noisy diff.
const PRIMITIVE_ARRAY = /\[\n((?:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null),?\n)+)\s*\]/gu;

function inlineShortArrays(text: string): string {
  return text.replace(PRIMITIVE_ARRAY, (match, body: string) => {
    const items = body
      .split("\n")
      .map((line) => line.trim().replace(/,$/u, ""))
      .filter(Boolean);
    const inline = `[${items.join(", ")}]`;
    return inline.length <= 100 ? inline : match;
  });
}

export function json(value: unknown, style: number | JsonStyle = 2): string {
  const resolved: JsonStyle = typeof style === "number" ? { indentation: style, inlineArrays: false } : style;
  const text = JSON.stringify(value, null, resolved.indentation) + "\n";
  return resolved.inlineArrays ? inlineShortArrays(text) : text;
}

export function indentationOf(content: string): number {
  const match = content.match(/^( +)"/m);
  return match?.[1]?.length ?? 2;
}

// The formatting an existing file already uses, so a merge changes only what it must.
export function styleOf(content: string): JsonStyle {
  return { indentation: indentationOf(content), inlineArrays: /\[\s*"[^\n]*"\s*(?:,\s*"[^\n]*"\s*)*\]/u.test(content) };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function artifactFromObserved(
  artifact: ObservedArtifact,
  packagePath: string,
): { kind: MarketplaceArtifactKind; path: string } | undefined {
  if (artifact.kind === "plugin-manifest" || artifact.kind === "marketplace-manifest") return undefined;
  const prefix = packagePath + "/";
  if (!artifact.relativePath.startsWith(prefix)) return undefined;
  const path = artifact.relativePath.slice(prefix.length);
  if (artifact.kind === "skill") {
    const parts = path.split("/");
    const skill = parts[1];
    return skill && parts[0] === "skills" ? { kind: "skill", path: "skills/" + skill } : undefined;
  }
  return { kind: artifact.kind as MarketplaceArtifactKind, path };
}

async function marketplaceEntryMetadata(
  root: string,
  packagePath: string,
): Promise<Record<string, unknown> | undefined> {
  const paths = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];
  for (const path of paths) {
    const content = await readOptionalText(join(root, path));
    if (!content) continue;
    try {
      const manifest = parseObject(content);
      if (!Array.isArray(manifest.plugins)) continue;
      const entry = manifest.plugins.find((candidate) => {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
        const source = (candidate as Record<string, unknown>).source;
        const sourcePath =
          typeof source === "string"
            ? source
            : typeof source === "object" && source !== null && !Array.isArray(source)
              ? (source as Record<string, unknown>).path
              : undefined;
        return typeof sourcePath === "string" && sourcePath.replace(/^\.\//, "") === packagePath;
      });
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) return entry as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return undefined;
}

// `observedArtifacts` is the marketplace observation the caller already holds: the layout is
// detected once per operation, never once per package.
export async function packageMetadata(
  root: string,
  packagePath: string,
  observedArtifacts: readonly ObservedArtifact[] | undefined,
): Promise<{
  name: string;
  version?: string;
  description?: string;
  artifacts: readonly { kind: MarketplaceArtifactKind; path: string }[];
}> {
  const candidates = [packagePath + "/.claude-plugin/plugin.json", packagePath + "/.codex-plugin/plugin.json"];
  let metadata: Record<string, unknown> | undefined;
  for (const path of candidates) {
    const content = await readOptionalText(join(root, path));
    if (content) {
      try {
        metadata = parseObject(content);
        break;
      } catch {
        continue;
      }
    }
  }
  const marketplaceMetadata = await marketplaceEntryMetadata(root, packagePath);
  const sourceMetadata = metadata ?? marketplaceMetadata;
  const packageArtifacts = (observedArtifacts ?? [])
    .filter((artifact) => artifact.packageId === packagePath)
    .map((artifact) => artifactFromObserved(artifact, packagePath))
    .filter((artifact): artifact is { kind: MarketplaceArtifactKind; path: string } => artifact !== undefined);
  const artifacts = [
    ...new Map(packageArtifacts.map((artifact) => [artifact.kind + ":" + artifact.path, artifact])).values(),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const version = optionalString(sourceMetadata?.version);
  const description = optionalString(sourceMetadata?.description);
  return {
    name: optionalString(sourceMetadata?.name) ?? packageSlugFromPath(packagePath),
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    artifacts,
  };
}

export async function packageManifests(
  root: string,
  marketplacePackages: readonly { path: string }[],
): Promise<readonly { path: string; manifest: PackageManifest }[]> {
  const paths = new Set(marketplacePackages.map((declaration) => declaration.path));
  const packageDirectory = await safeStat(join(root, "packages"));
  if (packageDirectory?.isDirectory()) {
    for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) paths.add("packages/" + entry.name);
    }
  }
  const found: { path: string; manifest: PackageManifest }[] = [];
  for (const path of paths) {
    const content = await readOptionalText(join(root, path, "omni.plugin.json"));
    if (!content) continue;
    found.push({ path, manifest: parsePackageManifest(parseObject(content)) });
  }
  return found;
}

export async function harnessMarketplaces(root: string): Promise<readonly HarnessMarketplace[]> {
  const definitions: readonly Readonly<{ harness: Harness; relativePath: string }>[] = [
    { harness: "claude-code", relativePath: ".claude-plugin/marketplace.json" },
    { harness: "codex", relativePath: ".agents/plugins/marketplace.json" },
  ];
  const found: HarnessMarketplace[] = [];
  for (const definition of definitions) {
    const content = await readOptionalText(join(root, definition.relativePath));
    if (!content) continue;
    found.push({ ...definition, content, manifest: parseObject(content) });
  }
  return found;
}

export function manifestAction(
  root: string,
  relativePath: string,
  content: string,
  beforeContent?: string,
): ManifestAction {
  return {
    kind: "write-file",
    relativePath,
    byteLength: Buffer.byteLength(content),
    manifest: true,
    absolutePath: join(root, relativePath),
    content,
    diff: createUnifiedDiff(
      `${relativePath} (${beforeContent === undefined ? "absent" : "current"})`,
      `${relativePath} (proposed)`,
      beforeContent ?? "",
      content,
    ).text,
    ...(beforeContent === undefined ? {} : { beforeContent, beforeHash: hashContent(beforeContent) }),
  };
}

export type CompatibilityObservedArtifact = Readonly<{
  packageId?: string;
  kind: InventorySnapshot["artifacts"][number]["kind"];
  path: string;
  content?: string;
}>;

export function observedArtifacts(inventory: InventorySnapshot): CompatibilityObservedArtifact[] {
  return inventory.artifacts.map((artifact) => ({
    packageId: artifact.packageId,
    kind: artifact.kind,
    path: artifact.relativePath,
  }));
}

export async function readArtifactContent(
  root: string,
  artifacts: readonly CompatibilityObservedArtifact[],
): Promise<CompatibilityObservedArtifact[]> {
  return Promise.all(
    artifacts.map(async (artifact) => ({
      ...artifact,
      content: await readOptionalText(join(root, artifact.path)),
    })),
  );
}

export function addDirectories(
  root: string,
  paths: readonly string[],
): { kind: "create-directory"; relativePath: string; absolutePath: string }[] {
  const directories = new Set<string>();
  for (const path of paths) {
    let current = dirname(path);
    while (current && current !== ".") {
      directories.add(current);
      current = dirname(current);
    }
  }
  const sorted = [...directories].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
  return sorted.map((directory) => ({
    kind: "create-directory" as const,
    relativePath: directory,
    absolutePath: join(root, directory),
  }));
}

export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export type BornMarketplaceManifest = Readonly<{
  relativePath: "omni.marketplace.json";
  manifest: MarketplaceManifest;
  content: string;
  beforeContent?: string;
}>;

export type PackageMetadata = Awaited<ReturnType<typeof packageMetadata>>;

export type BornPackageManifest = Readonly<{
  relativePath: string;
  manifest: PackageManifest;
  content: string;
  beforeContent?: string;
}>;

export async function packageManifestBirth(
  root: string,
  packagePath: string,
  metadata: PackageMetadata,
): Promise<BornPackageManifest> {
  const relativePath = `${packagePath}/omni.plugin.json`;
  const beforeContent = await readOptionalText(join(root, relativePath));
  if (beforeContent) {
    return {
      relativePath,
      manifest: parsePackageManifest(parseObject(beforeContent)),
      content: beforeContent,
      beforeContent,
    };
  }
  const manifest = createPackageManifest({
    id: packageSlugFromPath(packagePath),
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    artifacts: metadata.artifacts,
  });
  return { relativePath, manifest, content: json(manifest) };
}

export async function marketplaceManifestBirth(
  root: string,
  now: number,
  name = basename(root) || "Personal marketplace",
): Promise<BornMarketplaceManifest> {
  const relativePath = "omni.marketplace.json" as const;
  const beforeContent = await readOptionalText(join(root, relativePath));
  if (beforeContent) {
    return {
      relativePath,
      manifest: parseMarketplaceManifest(parseObject(beforeContent)),
      content: beforeContent,
      beforeContent,
    };
  }
  const created = createMarketplaceManifest({
    name,
    id: slugify(basename(root) || "personal") || "personal",
    createdAt: new Date(now).toISOString(),
  });
  return { relativePath, manifest: { ...created, packages: [] }, content: json({ ...created, packages: [] }) };
}
