import type { InventoryArtifactKind, InventoryDiagnostic, ObservedPackage } from "./inventory";
import type { EntryRef } from "./project-source-registry";

export type ExecutionClass = "static" | "executable";
export type ArtifactIdentity = Readonly<{
  artifactId: string;
  logicalId: string;
  contentHash: string;
  byteLength: number;
  executionClass: ExecutionClass;
  kind: InventoryArtifactKind;
  provenance: Readonly<{ root: EntryRef; packageId?: string; relativePath: string }>;
}>;

/** Maps an artifact id to the physical file identity it resolves to (see `ObservedArtifact.physicalIdentity`). */
export type PhysicalIdentityLookup = ReadonlyMap<string, string>;

export type IdentityFindingKind = "exact-duplicate" | "variant" | "unsupported-format" | "loose";
export type IdentityFinding = Readonly<{
  kind: IdentityFindingKind;
  severity: "info" | "warning";
  roots: readonly EntryRef[];
  count: number;
  /** First three artifact display names, for the renderer to surface as evidence. */
  examples: readonly string[];
  logicalId?: string;
  contentHash?: string;
  packageId?: string;
}>;

export const EXECUTABLE_KINDS = new Set<InventoryArtifactKind>(["hook", "mcp-config"]);
export const MANIFEST_KINDS = new Set<InventoryArtifactKind>(["plugin-manifest", "marketplace-manifest"]);
/** Unit kinds a `variant` finding may name — reusable artifacts, not per-project prose. */
export const REUSABLE_UNIT_KINDS = new Set<InventoryArtifactKind>(["skill", "command", "agent", "hook", "mcp-config"]);

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function pathSegments(path: string): string[] {
  return path.replaceAll("\\", "/").split("/");
}

/**
 * Folder prefix for a path sitting inside a `skills/<name>/` folder at any depth (e.g.
 * `.agents/skills/convex-setup-auth/references/clerk.md` -> `.agents/skills/convex-setup-auth`).
 * Loose skill folders are one logical unit: every file inside one shares this folder as its
 * logical id, regardless of the individual file's own kind.
 */
export function skillFolderPrefix(path: string): string | undefined {
  const segments = pathSegments(path);
  const index = segments.indexOf("skills");
  if (index === -1 || index + 1 >= segments.length) return undefined;
  return segments.slice(0, index + 2).join("/");
}

/** Whether a logical id was collapsed to a skill folder by `skillFolderPrefix`. */
export function isSkillFolderLogicalId(logicalId: string): boolean {
  const colonIndex = logicalId.indexOf(":");
  const path = colonIndex === -1 ? logicalId : logicalId.slice(colonIndex + 1);
  const segments = path.split("/");
  return segments.length >= 2 && segments.at(-2) === "skills";
}

export function stripExtension(basename: string): string {
  return basename.replace(/\.[^.]+$/, "");
}
export function executionClassForKind(kind: InventoryArtifactKind): ExecutionClass {
  return EXECUTABLE_KINDS.has(kind) ? "executable" : "static";
}

export function packageRelativePath(relativePath: string, packageInfo: ObservedPackage): string {
  const prefix = `${packageInfo.relativeRoot}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath;
}

export function artifactName(
  identity: Readonly<{ kind: InventoryArtifactKind; provenance: Readonly<{ relativePath: string }> }>,
  packageInfo?: ObservedPackage,
): string {
  const path = identity.provenance.relativePath.replaceAll("\\", "/");
  if (identity.kind === "skill" && path.endsWith("/SKILL.md")) return path.split("/").at(-2) ?? path;
  const basename = path.split("/").at(-1) ?? path;
  if (identity.kind === "plugin-manifest" && packageInfo) return `${packageInfo.displayName} manifest`;
  return basename.replace(/\.[^.]+$/, "");
}
export function rootKey(identity: ArtifactIdentity): string {
  return `${identity.provenance.root.kind}:${identity.provenance.root.id}`;
}

export function entryKey(entry: EntryRef): string {
  return `${entry.kind}:${entry.id}`;
}

export function rootsKey(roots: readonly EntryRef[]): string {
  return [...new Set(roots.map(entryKey))].sort(compare).join(",");
}

export function uniqueRoots(identities: readonly ArtifactIdentity[]): EntryRef[] {
  const seen = new Map<string, EntryRef>();
  for (const identity of identities) {
    const key = rootKey(identity);
    if (!seen.has(key)) seen.set(key, identity.provenance.root);
  }
  return [...seen.values()].sort((left, right) => compare(entryKey(left), entryKey(right)));
}

export function sortIdentities(identities: readonly ArtifactIdentity[]): ArtifactIdentity[] {
  return [...identities].sort(
    (left, right) =>
      compare(rootKey(left), rootKey(right)) || compare(left.provenance.relativePath, right.provenance.relativePath),
  );
}

export function resolvePackage(
  identity: ArtifactIdentity,
  packages: readonly ObservedPackage[],
): ObservedPackage | undefined {
  return identity.provenance.packageId
    ? packages.find((packageInfo) => packageInfo.id === identity.provenance.packageId)
    : undefined;
}
