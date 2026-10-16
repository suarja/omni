import { compatibilityMatrix, type CompatibilityHarness } from "./compatibility";
import type { InventoryArtifactKind, ObservedPackage } from "./inventory";

export type CompatibilityArtifactStatus = "transposable" | "partial" | "not-transposable";
export type CompatibilityPackageVerdict = "ready" | "partial" | "remote" | "blocked";

export type CompatibilityArtifact = Readonly<{
  path: string;
  kind: InventoryArtifactKind;
  status: CompatibilityArtifactStatus;
  reason?: string;
}>;

export type CompatibilityPackage = Readonly<{
  packageId: string;
  // What the user calls it (the observed display name), never a path.
  name: string;
  path: string;
  verdict: CompatibilityPackageVerdict;
  reason?: string;
  alreadyCompatible?: boolean;
  artifacts: readonly CompatibilityArtifact[];
}>;

export type CompatibilityReport = Readonly<{
  harness: "claude-code" | "codex";
  packages: readonly CompatibilityPackage[];
}>;

export type CompatibilityArtifactObservation = Readonly<{
  packageId?: string;
  kind: InventoryArtifactKind;
  path: string;
  content?: string;
  frontmatter?: Readonly<Record<string, unknown>>;
}>;

export type CompatibilityRemotePackage = Readonly<{
  name: string;
  description?: string;
  version?: string;
  locator?: string;
  source?: Readonly<{ source: "github" | "url" | "git"; repo?: string; url?: string; ref?: string }>;
}>;

export type CompatibilityMarketplaceObservation = Readonly<{
  packages: readonly (Pick<ObservedPackage, "id" | "manifestPaths"> &
    Partial<Pick<ObservedPackage, "relativeRoot" | "displayName" | "format">> &
    Readonly<{ manifestInvalid?: string }>)[];
  artifacts: readonly CompatibilityArtifactObservation[];
  remotePackages?: readonly CompatibilityRemotePackage[];
}>;

export type BuildCompatibilityReportOptions = Readonly<{
  marketplace: CompatibilityMarketplaceObservation;
  harness: "claude-code" | "codex";
  packageId?: string;
}>;

const codexCommandMarker = "Codex cannot project commands that use $ARGUMENTS.";
const codexFrontmatterMarker = "Codex cannot project harness-specific allowed-tools frontmatter.";
const codexAgentMarker = "Codex cannot project agents that name Claude Code tools.";
const codexHookMarker = "Codex cannot project hook files without a hook-schema adapter.";

function hasManifest(paths: readonly string[], suffix: string): boolean {
  return paths.some((path) => path === suffix || path.endsWith(`/${suffix}`));
}

function hasAllowedTools(artifact: CompatibilityArtifactObservation): boolean {
  if (artifact.frontmatter && Object.prototype.hasOwnProperty.call(artifact.frontmatter, "allowed-tools")) return true;
  return /^---[\s\S]*?^allowed-tools\s*:/mu.test(artifact.content ?? "");
}

function namesTool(artifact: CompatibilityArtifactObservation): boolean {
  return /\b(?:Bash|Edit|Glob|Grep|Read|Task|WebFetch|WebSearch|Write)\b/u.test(artifact.content ?? "");
}

function artifactStatus(
  artifact: CompatibilityArtifactObservation,
  harness: CompatibilityHarness,
): { status: CompatibilityArtifactStatus; reason: string } {
  const matrix = compatibilityMatrix[artifact.kind][harness];
  if (harness === "codex") {
    if (artifact.kind === "command" && artifact.content?.includes("$ARGUMENTS")) {
      return { status: "not-transposable", reason: codexCommandMarker };
    }
    if (hasAllowedTools(artifact)) return { status: "not-transposable", reason: codexFrontmatterMarker };
    if (artifact.kind === "agent" && namesTool(artifact)) {
      return { status: "not-transposable", reason: codexAgentMarker };
    }
    if (artifact.kind === "hook") return { status: "not-transposable", reason: codexHookMarker };
  }
  return {
    status: matrix.status === "yes" ? "transposable" : matrix.status === "partial" ? "partial" : "not-transposable",
    reason: matrix.reason,
  };
}

function artifactPath(artifact: CompatibilityArtifactObservation, packagePath: string): string {
  const prefix = `${packagePath}/`;
  return artifact.path.startsWith(prefix) ? artifact.path.slice(prefix.length) : artifact.path;
}

function remoteLocator(packageInfo: CompatibilityRemotePackage): string | undefined {
  if (packageInfo.source?.source === "github" && packageInfo.source.repo) return `github:${packageInfo.source.repo}`;
  if (packageInfo.source?.source === "url" && packageInfo.source.url) return `url:${packageInfo.source.url}`;
  if (packageInfo.source?.source === "git" && packageInfo.source.url) return `git:${packageInfo.source.url}`;
  return packageInfo.locator;
}

function isRemote(packageInfo: CompatibilityRemotePackage): boolean {
  const locator = remoteLocator(packageInfo);
  return Boolean(locator?.startsWith("github:") || locator?.startsWith("url:") || locator?.startsWith("git:"));
}

function localPackageReport(
  packageInfo: CompatibilityMarketplaceObservation["packages"][number],
  artifacts: readonly CompatibilityArtifactObservation[],
  harness: "claude-code" | "codex",
): CompatibilityPackage {
  const packagePath = packageInfo.relativeRoot ?? packageInfo.id;
  const packageArtifacts = artifacts
    .filter((artifact) => artifact.packageId === packageInfo.id || artifact.path.startsWith(`${packagePath}/`))
    .map((artifact) => {
      const classification = artifactStatus(artifact, harness);
      return {
        path: artifactPath(artifact, packagePath),
        kind: artifact.kind,
        status: classification.status,
        reason: classification.reason,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (packageInfo.manifestInvalid) {
    return {
      packageId: packageInfo.id,
      name: packageInfo.displayName ?? packagePath.split("/").at(-1) ?? packageInfo.id,
      path: packagePath,
      verdict: "blocked",
      reason: `Manifest is invalid: ${packageInfo.manifestInvalid}.`,
      artifacts: packageArtifacts,
    };
  }
  const firstProblem = packageArtifacts.find((artifact) => artifact.status !== "transposable");
  const verdict = firstProblem ? "partial" : "ready";
  return {
    packageId: packageInfo.id,
    name: packageInfo.displayName ?? packagePath.split("/").at(-1) ?? packageInfo.id,
    path: packagePath,
    verdict,
    ...(firstProblem?.reason ? { reason: firstProblem.reason } : {}),
    ...(verdict === "ready" &&
    hasManifest(packageInfo.manifestPaths, `.${harness === "codex" ? "codex" : "claude"}-plugin/plugin.json`)
      ? { alreadyCompatible: true }
      : {}),
    artifacts: packageArtifacts,
  };
}

function remotePackageReport(packageInfo: CompatibilityRemotePackage): CompatibilityPackage {
  return {
    packageId: packageInfo.name,
    name: packageInfo.name,
    path: packageInfo.name,
    verdict: "remote",
    ...(isRemote(packageInfo) ? {} : { reason: "Remote package is declared by hand only." }),
    artifacts: [],
  };
}

export function buildCompatibilityReport(options: BuildCompatibilityReportOptions): CompatibilityReport {
  const packageFilter = options.packageId;
  const packages = options.marketplace.packages
    .filter(
      (packageInfo) => !packageFilter || packageInfo.id === packageFilter || packageInfo.relativeRoot === packageFilter,
    )
    .map((packageInfo) => localPackageReport(packageInfo, options.marketplace.artifacts, options.harness));
  const remotePackages = packageFilter ? [] : (options.marketplace.remotePackages ?? []).map(remotePackageReport);
  return {
    harness: options.harness,
    packages: [...packages, ...remotePackages].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
