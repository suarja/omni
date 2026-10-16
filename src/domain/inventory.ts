import { createHash } from "node:crypto";
import { parseSkillOriginEvidence, validateSkillOriginLocations } from "./skill-origins/validation";
import type { SkillOriginEvidence } from "./skill-origins/types";

const INVENTORY_SCOPES = ["project", "user", "source", "provider-cache"] as const;
const EVIDENCE_CONFIDENCES = ["exact", "heuristic", "unknown"] as const;
const INVENTORY_ARTIFACT_KINDS = [
  "skill",
  "rule",
  "agent",
  "command",
  "hook",
  "mcp-config",
  "plugin-manifest",
  "marketplace-manifest",
  "instruction",
  "unknown",
] as const;
const SYMLINK_STATES = ["none", "inside-root", "broken", "external"] as const;
const DIAGNOSTIC_CODES = [
  "inaccessible",
  "malformed",
  "oversized",
  "broken-link",
  "outside-root",
  "unsupported",
  "duplicate-projection",
  "git-unavailable",
] as const;
const PACKAGE_STATES = ["not-installed", "current", "outdated", "drifted", "blocked", "unknown"] as const;
const ACTIVATION_STATES = ["active", "inactive", "not-applicable", "unknown"] as const;
const AUTHENTICATION_POLICIES = ["on-install", "on-use", "not-required", "unknown"] as const;
const AUTHENTICATION_STATES = ["authenticated", "unauthenticated", "unknown"] as const;
const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
const DIRTY_STATES = [true, false, "unknown"] as const;
const OBSERVED_PACKAGE_FORMATS = [
  "omni",
  "claude-plugin",
  "codex-plugin",
  "cursor-plugin",
  "agent-plugin",
  "implicit",
] as const;

export type InventoryScope = (typeof INVENTORY_SCOPES)[number];
export type InventoryObservationScope = Exclude<InventoryScope, "provider-cache">;
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCES)[number];
export type InventoryArtifactKind = (typeof INVENTORY_ARTIFACT_KINDS)[number];
export type SymlinkState = (typeof SYMLINK_STATES)[number];
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];
export type PackageState = (typeof PACKAGE_STATES)[number];
export type ActivationState = (typeof ACTIVATION_STATES)[number];
export type AuthenticationPolicy = (typeof AUTHENTICATION_POLICIES)[number];
export type AuthenticationState = (typeof AUTHENTICATION_STATES)[number];
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];
export type GitDirtyState = (typeof DIRTY_STATES)[number];
export type ObservedPackageFormat = (typeof OBSERVED_PACKAGE_FORMATS)[number];

export type ProviderStateEvidence = Readonly<{
  packageState: PackageState;
  activationState: ActivationState;
  authenticationPolicy: AuthenticationPolicy;
  authenticationState: AuthenticationState;
  revision?: string;
}>;

export type ObservedArtifact = Readonly<{
  id: string;
  physicalIdentity: string;
  projectionPaths: readonly string[];
  kind: InventoryArtifactKind;
  relativePath: string;
  displayPath: string;
  providerIds: readonly string[];
  scope: InventoryScope;
  confidence: EvidenceConfidence;
  symlinkState: SymlinkState;
  packageId?: string;
  providerState?: ProviderStateEvidence;
  summary?: string;
}>;

export type ObservedPackage = Readonly<{
  id: string;
  relativeRoot: string;
  displayName: string;
  manifestId?: string;
  format: ObservedPackageFormat;
  manifestPaths: readonly string[];
  description?: string;
  version?: string;
  readmePath?: string;
  declaredBy?: "marketplace-manifest";
  artifactIds: readonly string[];
}>;

export type RemotePackageDeclaration = Readonly<{
  name: string;
  description?: string;
  version?: string;
  locator: string;
}>;

export type InventoryMarketplace = Readonly<{
  name: string;
  /** Locally declared visibility; inventory does not verify remote publication. */
  visibility?: "private" | "public";
  description?: string;
  readmePath?: string;
  manifestPath: string;
  remotePackages?: readonly RemotePackageDeclaration[];
}>;

export type InventoryDiagnostic = Readonly<{
  location: string;
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
}>;

export type GitScope = Readonly<{
  id: string;
  relativeRoot: string;
  head?: string;
  branch?: string;
  dirty: GitDirtyState;
}>;

export type InventorySnapshot = Readonly<{
  rootHandle: string;
  displayRoot: string;
  observedAt: string;
  harnesses: readonly string[];
  artifacts: readonly ObservedArtifact[];
  /** Optional for old observations; new snapshots normalize it to an empty list. */
  skillOrigins?: readonly SkillOriginEvidence[];
  /** Optional for backwards-compatible callers; created snapshots always include it. */
  packages?: readonly ObservedPackage[];
  marketplace?: InventoryMarketplace;
  diagnostics: readonly InventoryDiagnostic[];
  gitScopes: readonly GitScope[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }

  return value.trim();
}
function readEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const text = readText(value, label);
  if (!values.includes(text as T)) {
    throw new Error(`Unsupported ${label}: ${text}.`);
  }

  return text as T;
}
function normalizeRelativeValue(value: unknown, label: string): string {
  const normalized = readText(value, label).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be relative and redacted.`);
  }

  return normalized;
}
function normalizeIdentifier(value: unknown, label: string): string {
  return normalizeRelativeValue(value, label);
}
function normalizeOpaqueIdentifier(value: unknown, label: string): string {
  const normalized = readText(value, label);
  const segments = normalized.split(/[\\/]/);
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe opaque identifier.`);
  }

  return normalized;
}
function normalizeSafeIdentifierList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  const values = value.map((entry) => normalizeIdentifier(entry, label));
  return [...new Set(values)];
}
function normalizeProviderIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Provider ids must be an array.");
  }

  const values = value.map((entry) => normalizeOpaqueIdentifier(entry, "Provider id"));
  return [...new Set(values)];
}
function normalizeRelativeList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  const values = value.map((entry) => normalizeRelativeValue(entry, label));
  return [...new Set(values)];
}
function normalizeOptionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const text = value.trim();
  return text || undefined;
}
function normalizeOptionalRelativeValue(value: unknown, label: string): string | undefined {
  const text = normalizeOptionalText(value, label);
  return text === undefined ? undefined : normalizeRelativeValue(text, label);
}
function normalizeRemoteText(value: unknown, label: string): string {
  const text = readText(value, label);
  if (text.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(text))
    throw new Error(`${label} must be at most 200 characters without control characters.`);
  return text;
}
function normalizeRemoteOptionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizeRemoteText(value, label);
}

function normalizeRemotePackage(value: unknown): RemotePackageDeclaration {
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Remote package declarations must be records.");
  const allowed = new Set(["name", "description", "version", "locator"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Remote package declaration has an unexpected field "${key}".`);
  const description = normalizeRemoteOptionalText(value.description, "Remote package description");
  const version = normalizeRemoteOptionalText(value.version, "Remote package version");
  return {
    name: normalizeRemoteText(value.name, "Remote package name"),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    locator: normalizeRemoteText(value.locator, "Remote package locator"),
  };
}
function normalizeOptionalSummary(value: unknown): string | undefined {
  const text = normalizeOptionalText(value, "Artifact summary");
  if (text === undefined) return undefined;
  return text.split(/\r?\n/, 1)[0]?.trim().slice(0, 240) || undefined;
}
function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return [...new Set(value.map((entry) => normalizeRelativeValue(entry, label)))];
}
function normalizeProviderState(value: unknown): ProviderStateEvidence {
  if (!isRecord(value)) {
    throw new Error("Provider state evidence must be a record.");
  }

  const revision = normalizeOptionalText(value.revision, "Provider revision");
  return {
    packageState: readEnum(value.packageState, PACKAGE_STATES, "package state"),
    activationState: readEnum(value.activationState, ACTIVATION_STATES, "activation state"),
    authenticationPolicy: readEnum(value.authenticationPolicy, AUTHENTICATION_POLICIES, "authentication policy"),
    authenticationState: readEnum(value.authenticationState, AUTHENTICATION_STATES, "authentication state"),
    ...(revision ? { revision } : {}),
  };
}

export function createProviderStateEvidence(value: unknown): ProviderStateEvidence {
  return normalizeProviderState(value);
}

export function stableInventoryId(
  identity: Readonly<{
    scope: string;
    kind: string;
    physicalIdentity?: string;
    relativePath?: string;
    providerIds: readonly string[];
  }>,
): string {
  const scope = readEnum(identity.scope, INVENTORY_SCOPES, "inventory scope");
  const kind = readEnum(identity.kind, INVENTORY_ARTIFACT_KINDS, "artifact kind");
  const physicalIdentity = normalizeRelativeValue(
    identity.physicalIdentity ?? identity.relativePath,
    "Physical identity",
  );
  const providerIds = normalizeProviderIds(identity.providerIds);
  const canonicalIdentity = JSON.stringify({
    scope,
    kind,
    physicalIdentity,
    providerIds: [...providerIds].sort(),
  });
  const digest = createHash("sha256").update(canonicalIdentity, "utf8").digest("hex");
  return `inventory-${digest}`;
}

export function createObservedArtifact(value: unknown): ObservedArtifact {
  if (!isRecord(value)) {
    throw new Error("Observed artifacts must be records.");
  }

  const kind = readEnum(value.kind, INVENTORY_ARTIFACT_KINDS, "artifact kind");
  const scope = readEnum(value.scope, INVENTORY_SCOPES, "inventory scope");
  const confidence = readEnum(value.confidence, EVIDENCE_CONFIDENCES, "evidence confidence");
  const symlinkState = readEnum(value.symlinkState, SYMLINK_STATES, "symlink state");
  const relativePath = normalizeRelativeValue(value.relativePath, "Artifact path");
  const displayPath = normalizeRelativeValue(value.displayPath, "Artifact display path");
  const physicalIdentity = normalizeRelativeValue(value.physicalIdentity ?? relativePath, "Physical identity");
  const projectionPaths =
    value.projectionPaths === undefined
      ? [relativePath]
      : normalizeRelativeList(value.projectionPaths, "Projection paths");
  const providerIds = normalizeProviderIds(value.providerIds);
  const packageId =
    value.packageId === undefined ? undefined : normalizeIdentifier(value.packageId, "Artifact package id");
  const id =
    value.id === undefined
      ? stableInventoryId({ scope, kind, physicalIdentity, providerIds })
      : normalizeIdentifier(value.id, "Artifact id");
  const providerState = value.providerState === undefined ? undefined : normalizeProviderState(value.providerState);
  const summary = normalizeOptionalSummary(value.summary);

  return {
    id,
    physicalIdentity,
    projectionPaths,
    kind,
    relativePath,
    displayPath,
    providerIds,
    scope,
    confidence,
    symlinkState,
    ...(packageId ? { packageId } : {}),
    ...(providerState ? { providerState } : {}),
    ...(summary ? { summary } : {}),
  };
}

export function createObservedPackage(value: unknown): ObservedPackage {
  if (!isRecord(value)) throw new Error("Observed packages must be records.");

  const declaredBy = value.declaredBy;
  if (declaredBy !== undefined && declaredBy !== "marketplace-manifest") {
    throw new Error("Unsupported observed package declaration.");
  }
  const manifestId = normalizeOptionalText(value.manifestId, "Package manifest id");
  const description = normalizeOptionalText(value.description, "Package description");
  const version = normalizeOptionalText(value.version, "Package version");
  const readmePath = normalizeOptionalRelativeValue(value.readmePath, "Package README path");
  return {
    id: normalizeIdentifier(value.id, "Package id"),
    relativeRoot: normalizeRelativeValue(value.relativeRoot, "Package root"),
    displayName: readText(value.displayName, "Package display name"),
    ...(manifestId ? { manifestId } : {}),
    format: readEnum(value.format, OBSERVED_PACKAGE_FORMATS, "package format"),
    manifestPaths: normalizeStringList(value.manifestPaths, "Package manifest paths"),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(readmePath ? { readmePath } : {}),
    ...(declaredBy ? { declaredBy } : {}),
    artifactIds: normalizeSafeIdentifierList(value.artifactIds, "Package artifact ids"),
  };
}

function normalizeMarketplace(value: unknown): InventoryMarketplace {
  if (!isRecord(value)) throw new Error("Inventory marketplace must be a record.");
  const description = normalizeOptionalText(value.description, "Marketplace description");
  const readmePath = normalizeOptionalRelativeValue(value.readmePath, "Marketplace README path");
  if (value.remotePackages !== undefined && !Array.isArray(value.remotePackages)) {
    throw new Error("Marketplace remote packages must be an array.");
  }
  const remotePackages = value.remotePackages?.map(normalizeRemotePackage);
  return {
    name: readText(value.name, "Marketplace name"),
    ...(value.visibility === undefined
      ? {}
      : { visibility: readEnum(value.visibility, ["private", "public"] as const, "marketplace visibility") }),
    ...(description ? { description } : {}),
    ...(readmePath ? { readmePath } : {}),
    manifestPath: normalizeRelativeValue(value.manifestPath, "Marketplace manifest path"),
    ...(remotePackages ? { remotePackages } : {}),
  };
}

export function createInventoryDiagnostic(value: unknown): InventoryDiagnostic {
  if (!isRecord(value)) {
    throw new Error("Inventory diagnostics must be records.");
  }

  return {
    location: normalizeRelativeValue(value.location, "Diagnostic location"),
    code: readEnum(value.code, DIAGNOSTIC_CODES, "diagnostic code"),
    severity: readEnum(value.severity, DIAGNOSTIC_SEVERITIES, "diagnostic severity"),
    message: readText(value.message, "Diagnostic message"),
  };
}

export function createGitScope(value: unknown): GitScope {
  if (!isRecord(value)) {
    throw new Error("Git scopes must be records.");
  }

  const dirty = value.dirty;
  if (!DIRTY_STATES.includes(dirty as GitDirtyState)) {
    throw new Error(`Unsupported git dirty state: ${String(dirty)}.`);
  }

  const head = normalizeOptionalText(value.head, "Git head");
  const branch = normalizeOptionalText(value.branch, "Git branch");
  if (branch && (!/^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/u.test(branch) || branch.includes("..")))
    throw new Error("Git branch is not safe for display.");
  return {
    id: normalizeIdentifier(value.id, "Git scope id"),
    relativeRoot: normalizeRelativeValue(value.relativeRoot, "Git scope root"),
    ...(head ? { head } : {}),
    ...(branch ? { branch } : {}),
    dirty: dirty as GitDirtyState,
  };
}

export function createInventorySnapshot(value: unknown): InventorySnapshot {
  if (!isRecord(value)) {
    throw new Error("Inventory snapshots must be records.");
  }
  if (!Array.isArray(value.artifacts)) {
    throw new Error("Inventory artifacts must be an array.");
  }
  if (!Array.isArray(value.diagnostics)) {
    throw new Error("Inventory diagnostics must be an array.");
  }
  if (!Array.isArray(value.gitScopes)) {
    throw new Error("Inventory git scopes must be an array.");
  }

  const artifacts = value.artifacts.map(createObservedArtifact);
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) {
    throw new Error("Inventory artifact ids must be unique.");
  }
  const stableIdentities = artifacts.map((artifact) =>
    stableInventoryId({
      scope: artifact.scope,
      kind: artifact.kind,
      physicalIdentity: artifact.physicalIdentity,
      providerIds: artifact.providerIds,
    }),
  );
  if (new Set(stableIdentities).size !== stableIdentities.length) {
    throw new Error("Inventory artifact identities must be unique.");
  }
  const physicalIdentities = artifacts.map((artifact) => artifact.physicalIdentity);
  if (new Set(physicalIdentities).size !== physicalIdentities.length) {
    throw new Error("Inventory physical identities must be unique.");
  }
  const gitScopes = value.gitScopes.map(createGitScope);
  if (new Set(gitScopes.map((scope) => scope.id)).size !== gitScopes.length) {
    throw new Error("Git scope ids must be unique.");
  }

  const packageValue = value.packages;
  if (packageValue !== undefined && !Array.isArray(packageValue)) {
    throw new Error("Inventory packages must be an array.");
  }
  const packages = packageValue === undefined ? [] : packageValue.map(createObservedPackage);
  if (new Set(packages.map((pkg) => pkg.id)).size !== packages.length) {
    throw new Error("Observed package ids must be unique.");
  }
  if (new Set(packages.map((pkg) => pkg.relativeRoot)).size !== packages.length) {
    throw new Error("Observed package roots must be unique.");
  }
  if (value.skillOrigins !== undefined && !Array.isArray(value.skillOrigins)) {
    throw new Error("Inventory skill origins must be an array.");
  }
  const skillOrigins = (value.skillOrigins ?? []).map(parseSkillOriginEvidence);
  validateSkillOriginLocations(skillOrigins, artifacts);

  return {
    rootHandle: readText(value.rootHandle, "Inventory root handle"),
    displayRoot: normalizeRelativeValue(value.displayRoot, "Inventory display root"),
    observedAt: readText(value.observedAt, "Inventory observed at"),
    harnesses: normalizeSafeIdentifierList(value.harnesses, "Inventory harnesses"),
    artifacts,
    skillOrigins,
    packages: packages.sort((left, right) => left.relativeRoot.localeCompare(right.relativeRoot)),
    ...(value.marketplace === undefined ? {} : { marketplace: normalizeMarketplace(value.marketplace) }),
    diagnostics: value.diagnostics.map(createInventoryDiagnostic),
    gitScopes,
  };
}
