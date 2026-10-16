import type { InventorySnapshot as DomainInventorySnapshot, ObservedArtifact } from "../domain/inventory";
import { parseSkillOriginEvidence, validateSkillOriginLocations } from "../domain/skill-origins/validation";

export type InventorySnapshot = DomainInventorySnapshot;

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
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const text = value.trim();
  return text || undefined;
}

function readOpaque(value: unknown, label: string): string {
  const text = readText(value, label);
  if (text.includes("/") || text.includes("\\") || text.includes("..")) {
    throw new Error(`${label} must be opaque.`);
  }
  return text;
}

function readRelative(value: unknown, label: string): string {
  const text = readText(value, label).replaceAll("\\", "/");
  if (
    text.startsWith("/") ||
    /^[a-zA-Z]:\//.test(text) ||
    text.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be relative.`);
  }
  return text;
}

function readOptionalRelative(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return readRelative(value, label);
}

function readOptionalSummary(value: unknown): string | undefined {
  const text = readOptionalText(value, "Artifact summary");
  if (text === undefined) return undefined;
  if (text.length > 240 || /[\r\n]/.test(text)) {
    throw new Error("Artifact summary must be at most 240 characters on one line.");
  }
  return text;
}

function readStringList(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of strings.`);
  }
}

function readSafeMessage(value: unknown): string {
  const text = readText(value, "Diagnostic message");
  if (
    text.length > 240 ||
    /[\r\n]/.test(text) ||
    /(?:password|secret|token|api[_-]?key|authorization)\s*[:=]/i.test(text) ||
    /(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(text)
  ) {
    throw new Error("Diagnostic message is not safe for IPC.");
  }
  return text;
}

function validateSnapshotShape(value: unknown): RecordValue {
  const snapshot = assertRecord(value, "Inventory snapshot");
  assertKeys(
    snapshot,
    [
      "rootHandle",
      "displayRoot",
      "observedAt",
      "harnesses",
      "artifacts",
      "skillOrigins",
      "packages",
      "marketplace",
      "diagnostics",
      "gitScopes",
    ],
    "Inventory snapshot",
  );
  if (
    !Array.isArray(snapshot.artifacts) ||
    !Array.isArray(snapshot.diagnostics) ||
    !Array.isArray(snapshot.gitScopes)
  ) {
    throw new Error("Inventory snapshot arrays are invalid.");
  }
  for (const value of snapshot.artifacts) {
    const artifact = assertRecord(value, "Inventory artifact");
    assertKeys(
      artifact,
      [
        "id",
        "physicalIdentity",
        "projectionPaths",
        "kind",
        "relativePath",
        "displayPath",
        "providerIds",
        "scope",
        "confidence",
        "symlinkState",
        "packageId",
        "providerState",
        "summary",
      ],
      "Inventory artifact",
    );
    if (artifact.packageId !== undefined) readRelative(artifact.packageId, "Artifact package id");
    readOptionalSummary(artifact.summary);
    if (artifact.providerState !== undefined) {
      const providerState = assertRecord(artifact.providerState, "Provider state");
      assertKeys(
        providerState,
        ["packageState", "activationState", "authenticationPolicy", "authenticationState", "revision"],
        "Provider state",
      );
      if (providerState.revision !== undefined && !/^[0-9a-f]{4,64}$/i.test(String(providerState.revision))) {
        throw new Error("Provider revision is not safe for IPC.");
      }
    }
  }
  if (snapshot.skillOrigins !== undefined) {
    if (!Array.isArray(snapshot.skillOrigins)) throw new Error("Inventory skill origins are invalid.");
    for (const origin of snapshot.skillOrigins) parseSkillOriginEvidence(origin);
  }
  if (snapshot.packages !== undefined) {
    if (!Array.isArray(snapshot.packages)) throw new Error("Inventory packages are invalid.");
    for (const value of snapshot.packages) {
      const pkg = assertRecord(value, "Observed package");
      assertKeys(
        pkg,
        [
          "id",
          "relativeRoot",
          "displayName",
          "manifestId",
          "format",
          "manifestPaths",
          "description",
          "version",
          "readmePath",
          "declaredBy",
          "artifactIds",
        ],
        "Observed package",
      );
      readRelative(pkg.id, "Package id");
      readRelative(pkg.relativeRoot, "Package root");
      readText(pkg.displayName, "Package display name");
      readOptionalText(pkg.manifestId, "Package manifest id");
      if (
        !["omni", "claude-plugin", "agent-plugin", "codex-plugin", "cursor-plugin", "implicit"].includes(
          String(pkg.format),
        )
      ) {
        throw new Error("Observed package format is invalid.");
      }
      if (pkg.declaredBy !== undefined && pkg.declaredBy !== "marketplace-manifest") {
        throw new Error("Observed package declaration is invalid.");
      }
      readStringList(pkg.manifestPaths, "Package manifest paths");
      readStringList(pkg.artifactIds, "Package artifact ids");
      readOptionalText(pkg.description, "Package description");
      readOptionalText(pkg.version, "Package version");
      readOptionalRelative(pkg.readmePath, "Package README path");
      for (const path of pkg.manifestPaths as string[]) readRelative(path, "Package manifest path");
      for (const id of pkg.artifactIds as string[]) readRelative(id, "Package artifact id");
    }
  }
  if (snapshot.marketplace !== undefined) {
    const marketplace = assertRecord(snapshot.marketplace, "Inventory marketplace");
    assertKeys(
      marketplace,
      ["name", "visibility", "description", "readmePath", "manifestPath", "remotePackages"],
      "Inventory marketplace",
    );
    readText(marketplace.name, "Marketplace name");
    if (
      marketplace.visibility !== undefined &&
      marketplace.visibility !== "private" &&
      marketplace.visibility !== "public"
    )
      throw new Error("Marketplace visibility is invalid.");
    readOptionalText(marketplace.description, "Marketplace description");
    readOptionalRelative(marketplace.readmePath, "Marketplace README path");
    readRelative(marketplace.manifestPath, "Marketplace manifest path");
    if (marketplace.remotePackages !== undefined) {
      if (!Array.isArray(marketplace.remotePackages)) throw new Error("Inventory remote packages are invalid.");
      for (const value of marketplace.remotePackages) {
        const remotePackage = assertRecord(value, "Remote package declaration");
        assertKeys(remotePackage, ["name", "description", "version", "locator"], "Remote package declaration");
        readText(remotePackage.name, "Remote package name");
        readOptionalText(remotePackage.description, "Remote package description");
        readOptionalText(remotePackage.version, "Remote package version");
        const locator = readText(remotePackage.locator, "Remote package locator");
        if (locator.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(locator)) {
          throw new Error("Remote package locator must be at most 200 characters without control characters.");
        }
      }
    }
  }
  for (const value of snapshot.diagnostics) {
    const diagnostic = assertRecord(value, "Inventory diagnostic");
    assertKeys(diagnostic, ["location", "code", "severity", "message"], "Inventory diagnostic");
    readSafeMessage(diagnostic.message);
  }
  for (const value of snapshot.gitScopes) {
    const scope = assertRecord(value, "Git scope");
    assertKeys(scope, ["id", "relativeRoot", "head", "branch", "dirty"], "Git scope");
    if (
      scope.branch !== undefined &&
      (typeof scope.branch !== "string" ||
        !/^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/u.test(scope.branch) ||
        scope.branch.includes(".."))
    )
      throw new Error("Git branch is not safe for IPC.");
    if (scope.head !== undefined && !/^[0-9a-f]{4,64}$/i.test(String(scope.head))) {
      throw new Error("Git head is not safe for IPC.");
    }
  }
  return snapshot;
}

export function parseInventorySnapshot(value: unknown): InventorySnapshot {
  const snapshot = validateSnapshotShape(value);
  readOpaque(snapshot.rootHandle, "Inventory root handle");
  if (snapshot.skillOrigins === undefined) return snapshot as unknown as InventorySnapshot;
  const skillOrigins = (snapshot.skillOrigins as unknown[]).map(parseSkillOriginEvidence);
  validateSkillOriginLocations(
    skillOrigins,
    snapshot.artifacts as unknown as readonly Pick<ObservedArtifact, "id" | "kind" | "projectionPaths">[],
  );
  return { ...snapshot, skillOrigins } as unknown as InventorySnapshot;
}
