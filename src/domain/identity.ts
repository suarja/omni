import type { InventoryArtifactKind, InventoryDiagnostic, ObservedPackage } from "./inventory";
import type { EntryRef } from "./project-source-registry";
import { skillFolderPrefix, deriveIdentityFindings as deriveFindings } from "./identity-findings";

export { collapsePhysicalProjections } from "./identity-findings";

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

const EXECUTABLE_KINDS = new Set<InventoryArtifactKind>(["hook", "mcp-config"]);
const MANIFEST_KINDS = new Set<InventoryArtifactKind>(["plugin-manifest", "marketplace-manifest"]);
/** Unit kinds a `variant` finding may name — reusable artifacts, not per-project prose. */
const REUSABLE_UNIT_KINDS = new Set<InventoryArtifactKind>(["skill", "command", "agent", "hook", "mcp-config"]);

function assertRelativePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Artifact identity path must be relative.");
  }
}

function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Artifact identity hash must be a lowercase SHA-256 hash.");
}

export function executionClassForKind(kind: InventoryArtifactKind): ExecutionClass {
  return EXECUTABLE_KINDS.has(kind) ? "executable" : "static";
}

function packageRelativePath(relativePath: string, packageInfo: ObservedPackage): string {
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

export function createArtifactIdentity(
  input: Readonly<{
    artifactId: string;
    contentHash: string;
    byteLength: number;
    kind: InventoryArtifactKind;
    root: EntryRef;
    relativePath: string;
    package?: ObservedPackage;
  }>,
): ArtifactIdentity {
  if (!input.artifactId.trim()) throw new Error("Artifact identity id is required.");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0)
    throw new Error("Artifact identity byte length is invalid.");
  assertRelativePath(input.relativePath);
  assertHash(input.contentHash);
  const packagePath = input.package ? packageRelativePath(input.relativePath, input.package) : undefined;
  const basePath = packagePath ?? input.relativePath;
  const logicalPath = skillFolderPrefix(basePath) ?? basePath;
  return {
    artifactId: input.artifactId,
    logicalId: input.package ? `${input.package.relativeRoot}/${logicalPath}` : `loose:${logicalPath}`,
    contentHash: input.contentHash,
    byteLength: input.byteLength,
    executionClass: executionClassForKind(input.kind),
    kind: input.kind,
    provenance: {
      root: input.root,
      ...(input.package ? { packageId: input.package.id } : {}),
      relativePath: input.relativePath,
    },
  };
}

export function deriveIdentityFindings(
  identities: readonly ArtifactIdentity[],
  packages: readonly ObservedPackage[],
  diagnostics: readonly InventoryDiagnostic[],
  physicalIdentities?: PhysicalIdentityLookup,
): readonly IdentityFinding[] {
  return deriveFindings(identities, packages, diagnostics, physicalIdentities);
}
