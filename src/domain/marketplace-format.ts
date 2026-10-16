export type MarketplaceArtifactKind = "skill" | "instruction" | "command" | "agent" | "hook" | "mcp-config";

export type MarketplaceArtifact = Readonly<{
  kind: MarketplaceArtifactKind;
  path: string;
  /** The artifact origin is independent of the plugin's own provenance. */
  provenance?: import("./artifact-provenance").ArtifactProvenance;
  variantOrigin?: import("./skill-reconciliation/variant-origin").SkillVariantOrigin;
}>;

import { parseSkillVariantOrigin } from "./skill-reconciliation/variant-origin";
import { parseArtifactProvenance } from "./artifact-provenance";

export type MarketplaceManifest = Readonly<{
  format: "omni.marketplace/1";
  id: string;
  name: string;
  visibility?: "private" | "public";
  createdAt: string;
  packages: readonly Readonly<{ path: string }>[];
  createdBy: string;
}>;

export type PackageProvenance = Readonly<{
  importedFrom?: Readonly<{
    sourceName: string;
    relativePath: string;
    contentHash: string;
    importedAt: string;
  }>;
  agent?: Readonly<{ harness: "claude-code" | "codex"; sessionName?: string; requestedAt: string }>;
  reason?: string;
}>;

export type PackageManifest = Readonly<{
  format: "omni.plugin/1";
  id: string;
  name: string;
  version: string;
  description?: string;
  license?: string;
  artifacts: readonly MarketplaceArtifact[];
  provenance?: PackageProvenance;
}>;

export type CreateMarketplaceManifestOptions = Readonly<{
  name: string;
  createdAt: string;
  createdBy?: string;
  id?: string;
}>;

export type CreatePackageManifestOptions = Readonly<{
  id: string;
  name: string;
  version?: string;
  description?: string;
  license?: string;
  artifacts?: readonly MarketplaceArtifact[];
  provenance?: PackageProvenance;
}>;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has an unexpected field "${key}".`);
  }
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function readTimestamp(value: unknown, label: string): string {
  const timestamp = readText(value, label);
  if (new Date(timestamp).toISOString() !== timestamp) throw new Error(`${label} must be an ISO-8601 timestamp.`);
  return timestamp;
}

function readId(value: unknown, label: string): string {
  const id = readText(value, label);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`${label} must be a lowercase slug.`);
  return id;
}

function readRelativePath(value: unknown, label: string): string {
  const path = readText(value, label).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return path;
}

function readOptionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : readText(value, label);
}

function readArtifact(value: unknown): MarketplaceArtifact {
  const artifact = assertRecord(value, "Marketplace artifact");
  assertKeys(artifact, ["kind", "path", "variantOrigin", "provenance"], "Marketplace artifact");
  const kinds: readonly MarketplaceArtifactKind[] = ["skill", "instruction", "command", "agent", "hook", "mcp-config"];
  if (!kinds.includes(artifact.kind as MarketplaceArtifactKind))
    throw new Error("Marketplace artifact kind is invalid.");
  if (artifact.variantOrigin !== undefined && artifact.kind !== "skill") {
    throw new Error("Only skill artifacts may carry a variant origin.");
  }
  return {
    kind: artifact.kind as MarketplaceArtifactKind,
    path: readRelativePath(artifact.path, "Marketplace artifact path"),
    ...(artifact.provenance === undefined ? {} : { provenance: parseArtifactProvenance(artifact.provenance) }),
    ...(artifact.variantOrigin === undefined ? {} : { variantOrigin: parseSkillVariantOrigin(artifact.variantOrigin) }),
  };
}

function readProvenance(value: unknown): PackageProvenance {
  const provenance = assertRecord(value, "Package provenance");
  assertKeys(provenance, ["importedFrom", "agent", "reason"], "Package provenance");
  const importedFrom =
    provenance.importedFrom === undefined ? undefined : assertRecord(provenance.importedFrom, "Imported source");
  if (importedFrom)
    assertKeys(importedFrom, ["sourceName", "relativePath", "contentHash", "importedAt"], "Imported source");
  const agent = provenance.agent === undefined ? undefined : assertRecord(provenance.agent, "Agent provenance");
  if (agent) {
    assertKeys(agent, ["harness", "sessionName", "requestedAt"], "Agent provenance");
    if (agent.harness !== "claude-code" && agent.harness !== "codex") throw new Error("Agent harness is invalid.");
  }
  if (!importedFrom && !agent && provenance.reason === undefined) throw new Error("Package provenance is empty.");
  return {
    ...(importedFrom
      ? {
          importedFrom: {
            sourceName: readText(importedFrom.sourceName, "Source name"),
            relativePath: readRelativePath(importedFrom.relativePath, "Imported relative path"),
            contentHash: readText(importedFrom.contentHash, "Content hash"),
            importedAt: readTimestamp(importedFrom.importedAt, "Imported at"),
          },
        }
      : {}),
    ...(agent
      ? {
          agent: {
            harness: agent.harness as "claude-code" | "codex",
            ...(agent.sessionName === undefined ? {} : { sessionName: readText(agent.sessionName, "Session name") }),
            requestedAt: readTimestamp(agent.requestedAt, "Requested at"),
          },
        }
      : {}),
    ...(provenance.reason === undefined ? {} : { reason: readText(provenance.reason, "Provenance reason") }),
  };
}

export function slugify(name: string): string {
  if (typeof name !== "string") return "";
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function createMarketplaceManifest(options: CreateMarketplaceManifestOptions): MarketplaceManifest {
  const name = readText(options.name, "Marketplace name");
  const id = options.id === undefined ? slugify(name) : readId(options.id, "Marketplace id");
  if (!id) throw new Error("Marketplace name must produce a valid slug.");
  return {
    format: "omni.marketplace/1",
    id,
    name,
    createdAt: readTimestamp(options.createdAt, "Created at"),
    packages: [{ path: `packages/${id}` }],
    createdBy: readText(options.createdBy ?? "omni-desktop/0.1.0", "Created by"),
  };
}

export function createPackageManifest(options: CreatePackageManifestOptions): PackageManifest {
  const manifest: PackageManifest = {
    format: "omni.plugin/1",
    id: readId(options.id, "Package id"),
    name: readText(options.name, "Package name"),
    version: readText(options.version ?? "0.1.0", "Package version"),
    artifacts: [...(options.artifacts ?? [])].map(readArtifact),
    ...(options.description === undefined ? {} : { description: readText(options.description, "Package description") }),
    ...(options.license === undefined ? {} : { license: readText(options.license, "Package license") }),
    ...(options.provenance === undefined ? {} : { provenance: readProvenance(options.provenance) }),
  };
  return manifest;
}

export function parseMarketplaceManifest(value: unknown): MarketplaceManifest {
  const manifest = assertRecord(value, "Marketplace manifest");
  assertKeys(
    manifest,
    ["format", "id", "name", "visibility", "createdAt", "packages", "createdBy"],
    "Marketplace manifest",
  );
  if (manifest.visibility !== undefined && manifest.visibility !== "private" && manifest.visibility !== "public")
    throw new Error("Marketplace visibility must be private or public.");
  if (manifest.format !== "omni.marketplace/1") throw new Error("Marketplace manifest format is unsupported.");
  if (!Array.isArray(manifest.packages)) throw new Error("Marketplace packages must be an array.");
  const packages = manifest.packages.map((value) => {
    const entry = assertRecord(value, "Marketplace package entry");
    assertKeys(entry, ["path"], "Marketplace package entry");
    return { path: readRelativePath(entry.path, "Marketplace package path") };
  });
  return {
    format: "omni.marketplace/1",
    id: readId(manifest.id, "Marketplace id"),
    name: readText(manifest.name, "Marketplace name"),
    ...(manifest.visibility === undefined ? {} : { visibility: manifest.visibility }),
    createdAt: readTimestamp(manifest.createdAt, "Created at"),
    packages,
    createdBy: readText(manifest.createdBy, "Created by"),
  };
}

export function parsePackageManifest(value: unknown): PackageManifest {
  const manifest = assertRecord(value, "Package manifest");
  assertKeys(
    manifest,
    ["format", "id", "name", "version", "description", "license", "artifacts", "provenance"],
    "Package manifest",
  );
  if (manifest.format !== "omni.plugin/1") throw new Error("Package manifest format is unsupported.");
  if (!Array.isArray(manifest.artifacts)) throw new Error("Package artifacts must be an array.");
  return {
    format: "omni.plugin/1",
    id: readId(manifest.id, "Package id"),
    name: readText(manifest.name, "Package name"),
    version: readText(manifest.version, "Package version"),
    ...(readOptionalText(manifest.description, "Package description") === undefined
      ? {}
      : { description: readOptionalText(manifest.description, "Package description") }),
    ...(readOptionalText(manifest.license, "Package license") === undefined
      ? {}
      : { license: readOptionalText(manifest.license, "Package license") }),
    artifacts: manifest.artifacts.map(readArtifact),
    ...(manifest.provenance === undefined ? {} : { provenance: readProvenance(manifest.provenance) }),
  };
}

export function packageSlugFromPath(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? "";
}
