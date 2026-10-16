import type { InventoryDiagnostic, RemotePackageDeclaration } from "../../domain/inventory";
import { diagnostic } from "./shared";
import {
  safeRelativePath,
  optionalManifestText,
  remoteDisplayText,
  remoteNameFromLocator,
  isRemoteString,
  type PackageDeclaration,
  type ManifestDeclarations,
} from "./source-layout-utils";

function remoteDeclaration(
  candidate: unknown,
  entry: Record<string, unknown> | undefined,
): RemotePackageDeclaration | undefined {
  const source =
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : undefined;
  const sourceKind = source ? optionalManifestText(source.source) : undefined;
  const ref = source ? optionalManifestText(source.ref) : undefined;
  const raw = source ? (source.repo ?? source.url) : candidate;
  const rawLocator = optionalManifestText(raw);
  const name = remoteDisplayText(entry?.name);
  const description = remoteDisplayText(entry?.description);
  const version = remoteDisplayText(entry?.version);
  const metadata = {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
  };
  if (sourceKind === "github" && rawLocator) {
    return {
      ...metadata,
      name: name ?? remoteNameFromLocator(rawLocator),
      locator: `github:${rawLocator}${ref ? `@${ref}` : ""}`,
    };
  }
  if ((sourceKind === "git" || sourceKind === "url") && rawLocator) {
    return {
      ...metadata,
      name: name ?? remoteNameFromLocator(rawLocator),
      locator: `${sourceKind}:${rawLocator}${ref && sourceKind === "git" ? `@${ref}` : ""}`,
    };
  }
  if (typeof candidate === "string" && candidate.trim() && isRemoteString(candidate)) {
    const trimmed = candidate.trim();
    const locator = trimmed.startsWith("github:") ? trimmed : `url:${trimmed}`;
    return { ...metadata, name: name ?? remoteNameFromLocator(locator), locator };
  }
  return undefined;
}

export function declaredPackagesFromManifest(
  path: string,
  manifest: Record<string, unknown> | undefined,
  diagnostics: InventoryDiagnostic[],
): ManifestDeclarations {
  if (!manifest) return { local: [], remote: [] };
  const values = path === "omni.marketplace.json" ? manifest.packages : manifest.plugins;
  if (values === undefined) return { local: [], remote: [] };
  if (!Array.isArray(values)) {
    diagnostics.push(diagnostic(path, "malformed", "The marketplace package list is malformed."));
    return { local: [], remote: [] };
  }
  const packages: PackageDeclaration[] = [];
  const remote: RemotePackageDeclaration[] = [];
  for (const value of values) {
    const entry =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const candidate = entry ? (entry.path ?? entry.source) : value;
    const source =
      typeof candidate === "object" && candidate !== null ? (candidate as Record<string, unknown>).source : candidate;
    const remotePackage = remoteDeclaration(candidate, entry);
    if (remotePackage) {
      remote.push(remotePackage);
      continue;
    }
    const normalized = safeRelativePath(source);
    if (!normalized) {
      diagnostics.push(diagnostic(path, "malformed", "A declared package path is malformed."));
      continue;
    }
    const description = optionalManifestText(entry?.description);
    const version = optionalManifestText(entry?.version);
    packages.push({
      path: normalized,
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
    });
  }
  return {
    local: [...new Map(packages.map((pkg) => [pkg.path, pkg])).values()].sort((left, right) =>
      compareCodeUnits(left.path, right.path),
    ),
    remote: [...new Map(remote.map((pkg) => [pkg.locator, pkg])).values()].sort((left, right) =>
      compareCodeUnits(left.locator, right.locator),
    ),
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
