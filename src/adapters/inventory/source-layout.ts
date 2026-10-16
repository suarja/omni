import type {
  InventoryDiagnostic,
  InventoryObservationScope,
  InventoryMarketplace,
  ObservedPackage,
  ObservedPackageFormat,
  RemotePackageDeclaration,
} from "../../domain/inventory";
import type { PackageDeclaration } from "./source-layout-utils";
import { createInventoryDiagnostic, createObservedArtifact } from "../../domain/inventory";
import type { InventoryDirectoryEntry, InventoryFilesystemPort } from "../../ports/inventory";
import {
  diagnostic,
  errorDiagnostic,
  fileLocation,
  scanInventoryLocations,
  treeLocation,
  type InventoryDetector,
  type InventoryDetectorResult,
  type ScanLocation,
} from "./shared";
import {
  compare,
  join,
  packageName,
  parseManifestShape,
  optionalManifestText,
  packageRootPath,
  readmePath,
  readJson,
} from "./source-layout-utils";
import { declaredPackagesFromManifest } from "./source-layout-declarations";
import { supportsPortablePluginManifest } from "./portable-plugin";
const MANIFESTS: readonly Readonly<{ name: string; format: ObservedPackageFormat }>[] = [
  { name: "omni.plugin.json", format: "omni" },
  { name: ".claude-plugin/plugin.json", format: "claude-plugin" },
  { name: "plugin.json", format: "agent-plugin" },
  { name: ".codex-plugin/plugin.json", format: "codex-plugin" },
  { name: ".cursor-plugin/plugin.json", format: "cursor-plugin" },
];
const ROOT_MARKETPLACES = ["omni.marketplace.json", ".claude-plugin/marketplace.json", "marketplace.json"] as const;
const EXCLUDED = new Set([".git", "node_modules"]);
const SOURCE_PROVIDER_ID = "source-layout";
async function readDirectory(
  filesystem: InventoryFilesystemPort,
  path: string,
  diagnostics: InventoryDiagnostic[],
): Promise<readonly InventoryDirectoryEntry[]> {
  try {
    return await filesystem.listDirectory(path);
  } catch (error: unknown) {
    const issue = errorDiagnostic(path, error);
    if (issue) diagnostics.push(issue);
    return [];
  }
}
async function knownManifestPaths(
  filesystem: InventoryFilesystemPort,
  relativeRoot: string,
  diagnostics: InventoryDiagnostic[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const manifest of MANIFESTS) {
    const path = join(relativeRoot, manifest.name);
    try {
      const location = await filesystem.lstat(path);
      if (location.type === "file" || location.type === "symlink") {
        if (
          manifest.format !== "agent-plugin" ||
          (await supportsPortablePluginManifest(filesystem, path, diagnostics))
        ) {
          paths.push(path);
        }
      }
    } catch (error: unknown) {
      const issue = errorDiagnostic(path, error);
      if (issue && issue.code !== "unsupported") diagnostics.push(issue);
    }
  }
  return paths;
}
async function hasSkillTree(
  filesystem: InventoryFilesystemPort,
  relativeRoot: string,
  diagnostics: InventoryDiagnostic[],
): Promise<boolean> {
  const entries = await readDirectory(filesystem, join(relativeRoot, "skills"), diagnostics);
  for (const entry of entries) {
    if (entry.type !== "directory") continue;
    try {
      const skill = await filesystem.lstat(join(join(relativeRoot, "skills"), join(entry.name, "SKILL.md")));
      if (skill.type === "file" || skill.type === "symlink") return true;
    } catch (error: unknown) {
      const issue = errorDiagnostic(join(join(relativeRoot, "skills"), join(entry.name, "SKILL.md")), error);
      if (issue && issue.code !== "unsupported") diagnostics.push(issue);
    }
  }
  return false;
}
async function discoverPackageRoots(
  filesystem: InventoryFilesystemPort,
  declared: readonly string[],
  diagnostics: InventoryDiagnostic[],
): Promise<string[]> {
  const roots = new Set(declared);
  const topLevel = await readDirectory(filesystem, "", diagnostics);
  for (const entry of topLevel) {
    if (entry.type !== "directory" || entry.name.startsWith(".") || EXCLUDED.has(entry.name)) continue;
    const root = entry.name;
    roots.add(root);
    if (root === "plugins") {
      for (const child of await readDirectory(filesystem, root, diagnostics)) {
        if (child.type === "directory" && !child.name.startsWith(".") && !EXCLUDED.has(child.name)) {
          roots.add(join(root, child.name));
        }
      }
    }
  }
  const packages: string[] = [];
  for (const root of [...roots].sort(compare)) {
    const manifests = await knownManifestPaths(filesystem, root, diagnostics);
    if (manifests.length) {
      packages.push(root);
    } else if (await hasSkillTree(filesystem, root, diagnostics)) {
      packages.push(root);
      diagnostics.push(
        createInventoryDiagnostic({
          location: root,
          code: "unsupported",
          severity: "info",
          message: "Skills were observed without a known package manifest.",
        }),
      );
    }
  }
  return [...new Set(packages)].sort(compare);
}
async function directFiles(
  filesystem: InventoryFilesystemPort,
  directory: string,
  predicate: (entry: InventoryDirectoryEntry) => boolean,
  diagnostics: InventoryDiagnostic[],
): Promise<string[]> {
  const entries = await readDirectory(filesystem, directory, diagnostics);
  return entries
    .filter((entry) => (entry.type === "file" || entry.type === "symlink") && predicate(entry))
    .map((entry) => join(directory, entry.name));
}
async function packageLocations(
  filesystem: InventoryFilesystemPort,
  relativeRoot: string,
  diagnostics: InventoryDiagnostic[],
): Promise<ScanLocation[]> {
  const locations: ScanLocation[] = [];
  for (const path of await knownManifestPaths(filesystem, relativeRoot, diagnostics)) {
    locations.push(fileLocation(path, "plugin-manifest", "json"));
  }
  for (const path of await directFiles(
    filesystem,
    join(relativeRoot, "commands"),
    (entry) => entry.name.endsWith(".md"),
    diagnostics,
  )) {
    locations.push(fileLocation(path, "command", "frontmatter"));
  }
  for (const path of await directFiles(
    filesystem,
    join(relativeRoot, "agents"),
    (entry) => entry.name.endsWith(".md"),
    diagnostics,
  )) {
    locations.push(fileLocation(path, "agent", "frontmatter"));
  }
  for (const path of await directFiles(
    filesystem,
    join(relativeRoot, "instructions"),
    (entry) => entry.name.endsWith(".md"),
    diagnostics,
  )) {
    locations.push(fileLocation(path, "instruction"));
  }
  for (const path of await directFiles(
    filesystem,
    join(relativeRoot, "mcp"),
    (entry) => entry.name.endsWith(".json"),
    diagnostics,
  )) {
    locations.push(fileLocation(path, "mcp-config", "json"));
  }
  for (const entry of await readDirectory(filesystem, join(relativeRoot, "skills"), diagnostics)) {
    if (entry.type !== "directory") continue;
    const path = join(join(relativeRoot, "skills"), join(entry.name, "SKILL.md"));
    try {
      const location = await filesystem.lstat(path);
      if (location.type === "file" || location.type === "symlink")
        locations.push(fileLocation(path, "skill", "skill-frontmatter"));
    } catch (error: unknown) {
      const issue = errorDiagnostic(path, error);
      if (issue && issue.code !== "unsupported") diagnostics.push(issue);
    }
  }
  try {
    const hooks = await filesystem.lstat(join(relativeRoot, "hooks"));
    if (hooks.type === "directory") locations.push(treeLocation(join(relativeRoot, "hooks"), "hook"));
    else if (hooks.type === "file" || hooks.type === "symlink")
      locations.push(fileLocation(join(relativeRoot, "hooks"), "hook"));
  } catch (error: unknown) {
    const issue = errorDiagnostic(join(relativeRoot, "hooks"), error);
    if (issue && issue.code !== "unsupported") diagnostics.push(issue);
  }
  for (const name of ["AGENTS.md", "CLAUDE.md", ".mcp.json"]) {
    const path = join(relativeRoot, name);
    try {
      const location = await filesystem.lstat(path);
      if (location.type === "file" || location.type === "symlink") {
        locations.push(
          fileLocation(
            path,
            name === ".mcp.json" ? "mcp-config" : "instruction",
            name === ".mcp.json" ? "json" : undefined,
          ),
        );
      }
    } catch (error: unknown) {
      const issue = errorDiagnostic(path, error);
      if (issue && issue.code !== "unsupported") diagnostics.push(issue);
    }
  }
  return locations;
}
async function looseLocations(
  filesystem: InventoryFilesystemPort,
  diagnostics: InventoryDiagnostic[],
): Promise<ScanLocation[]> {
  return packageLocations(filesystem, "", diagnostics);
}
async function packageEvidence(
  filesystem: InventoryFilesystemPort,
  relativeRoot: string,
  declared: boolean,
  diagnostics: InventoryDiagnostic[],
  manifestPathsOverride?: readonly string[],
  declaration?: PackageDeclaration,
): Promise<ObservedPackage> {
  const manifestPaths = manifestPathsOverride
    ? [...manifestPathsOverride]
    : await knownManifestPaths(filesystem, relativeRoot, diagnostics);
  const firstManifest = MANIFESTS.find((manifest) =>
    manifestPaths.includes(relativeRoot === "root" ? manifest.name : join(relativeRoot, manifest.name)),
  );
  let manifest: Record<string, unknown> | undefined;
  if (firstManifest) {
    const manifestPath = relativeRoot === "root" ? firstManifest.name : join(relativeRoot, firstManifest.name);
    manifest = await readJson(filesystem, manifestPath, diagnostics);
  }
  const manifestId = optionalManifestText(manifest?.id);
  const description = declaration?.description ?? optionalManifestText(manifest?.description);
  const version = declaration?.version ?? optionalManifestText(manifest?.version);
  const packageReadmePath = await readmePath(filesystem, relativeRoot, diagnostics);
  return {
    id: relativeRoot,
    relativeRoot,
    displayName: packageName(relativeRoot, manifest),
    ...(manifestId ? { manifestId } : {}),
    format: firstManifest?.format ?? "implicit",
    manifestPaths,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(packageReadmePath ? { readmePath: packageReadmePath } : {}),
    ...(declared ? { declaredBy: "marketplace-manifest" as const } : {}),
    artifactIds: [],
  };
}
async function marketplaceDetails(
  filesystem: InventoryFilesystemPort,
  path: string,
  manifest: Record<string, unknown> | undefined,
  diagnostics: InventoryDiagnostic[],
  remotePackages: readonly RemotePackageDeclaration[],
): Promise<InventoryMarketplace | undefined> {
  const name = optionalManifestText(manifest?.name);
  if (!name) return undefined;
  const metadata = manifest?.metadata;
  const description =
    optionalManifestText(manifest?.description) ??
    optionalManifestText(
      typeof metadata === "object" && metadata !== null && "description" in metadata ? metadata.description : undefined,
    );
  const rootReadmePath = await readmePath(filesystem, "", diagnostics);
  return {
    name,
    ...(manifest?.visibility === "private" || manifest?.visibility === "public"
      ? { visibility: manifest.visibility }
      : {}),
    ...(description ? { description } : {}),
    ...(rootReadmePath ? { readmePath: rootReadmePath } : {}),
    manifestPath: path,
    ...(remotePackages.length ? { remotePackages } : {}),
  };
}
function packageForPath(path: string, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => path.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length || compare(left, right))[0];
}
export function associateObservedPackages(
  packages: readonly ObservedPackage[],
  artifacts: readonly import("../../domain/inventory").ObservedArtifact[],
): ObservedPackage[] {
  return [...new Map(packages.map((pkg) => [pkg.id, pkg])).values()]
    .map((pkg) => ({
      ...pkg,
      artifactIds: artifacts.filter((artifact) => artifact.packageId === pkg.id).map((artifact) => artifact.id),
    }))
    .sort((left, right) => compare(left.relativeRoot, right.relativeRoot));
}
export async function detectSourceLayout(
  filesystem: InventoryFilesystemPort,
  scope: InventoryObservationScope = "source",
): Promise<InventoryDetectorResult> {
  const diagnostics: InventoryDiagnostic[] = [];
  if (scope !== "source") {
    const rootPluginManifests = await knownManifestPaths(filesystem, "", diagnostics);
    if (!rootPluginManifests.length) return { providerId: SOURCE_PROVIDER_ID, artifacts: [], diagnostics };
    const packageInfo = await packageEvidence(filesystem, "root", false, diagnostics, rootPluginManifests);
    const locations = rootPluginManifests.includes("plugin.json")
      ? await packageLocations(filesystem, "", diagnostics)
      : rootPluginManifests.map((path) => fileLocation(path, "plugin-manifest", "json"));
    const scanned = await scanInventoryLocations(SOURCE_PROVIDER_ID, filesystem, locations, scope);
    const artifacts = scanned.artifacts.map((artifact) =>
      createObservedArtifact({ ...artifact, providerIds: [], packageId: packageInfo.id }),
    );
    return {
      providerId: SOURCE_PROVIDER_ID,
      artifacts,
      packages: [{ ...packageInfo, artifactIds: artifacts.map((artifact) => artifact.id) }],
      diagnostics: [...diagnostics, ...scanned.diagnostics],
    };
  }

  const rootManifests = await knownManifestPaths(filesystem, "", diagnostics);
  if (rootManifests.includes("plugin.json")) {
    const packageInfo = await packageEvidence(filesystem, "root", false, diagnostics, rootManifests);
    const scanned = await scanInventoryLocations(
      SOURCE_PROVIDER_ID,
      filesystem,
      await packageLocations(filesystem, "", diagnostics),
      scope,
    );
    const artifacts = scanned.artifacts.map((artifact) =>
      createObservedArtifact({ ...artifact, providerIds: [], packageId: packageInfo.id }),
    );
    return {
      providerId: SOURCE_PROVIDER_ID,
      artifacts,
      packages: [{ ...packageInfo, artifactIds: artifacts.map((artifact) => artifact.id) }],
      diagnostics: [...diagnostics, ...scanned.diagnostics],
    };
  }

  const declared = new Set<string>();
  const declarations = new Map<string, PackageDeclaration>();
  const marketplaceManifests: Readonly<{
    path: string;
    manifest: Record<string, unknown> | undefined;
    remotePackages: readonly RemotePackageDeclaration[];
  }>[] = [];
  for (const path of ROOT_MARKETPLACES) {
    let exists = false;
    try {
      const location = await filesystem.lstat(path);
      exists = location.type === "file" || location.type === "symlink";
    } catch (error: unknown) {
      const issue = errorDiagnostic(path, error);
      if (issue) diagnostics.push(issue);
    }
    if (!exists) continue;
    const manifest = await readJson(filesystem, path, diagnostics);
    const declarationsFromManifest = declaredPackagesFromManifest(path, manifest, diagnostics);
    marketplaceManifests.push({ path, manifest, remotePackages: declarationsFromManifest.remote });
    for (const declaration of declarationsFromManifest.local) {
      declared.add(declaration.path);
      if (!declarations.has(declaration.path)) declarations.set(declaration.path, declaration);
    }
  }

  const packageRoots = await discoverPackageRoots(filesystem, [...declared], diagnostics);
  const locations = [
    ...(await looseLocations(filesystem, diagnostics)),
    ...ROOT_MARKETPLACES.map((path) => fileLocation(path, "marketplace-manifest", "json")),
  ];
  for (const root of packageRoots) locations.push(...(await packageLocations(filesystem, root, diagnostics)));
  const scanned = await scanInventoryLocations(SOURCE_PROVIDER_ID, filesystem, locations, scope);
  const artifacts = scanned.artifacts.map((artifact) => {
    const packageId = packageForPath(artifact.relativePath, packageRoots);
    return createObservedArtifact({
      ...artifact,
      providerIds: [],
      ...(packageId ? { packageId } : {}),
    });
  });
  const packages = await Promise.all(
    packageRoots.map((root) =>
      packageEvidence(filesystem, root, declared.has(root), diagnostics, undefined, declarations.get(root)),
    ),
  );
  const packageRecords = packages.map((pkg) => ({
    ...pkg,
    artifactIds: artifacts.filter((artifact) => artifact.packageId === pkg.id).map((artifact) => artifact.id),
  }));
  const marketplaceCandidates = await Promise.all(
    marketplaceManifests.map(({ path, manifest, remotePackages }) =>
      marketplaceDetails(filesystem, path, manifest, diagnostics, remotePackages),
    ),
  );
  const marketplace = marketplaceCandidates.find(Boolean);
  return {
    providerId: SOURCE_PROVIDER_ID,
    artifacts,
    packages: packageRecords,
    ...(marketplace ? { marketplace } : {}),
    diagnostics: [...diagnostics, ...scanned.diagnostics].sort(
      (left, right) => compare(left.location, right.location) || compare(left.code, right.code),
    ),
  };
}

export const sourceLayoutInventoryDetector: InventoryDetector = {
  providerId: SOURCE_PROVIDER_ID,
  harnessAgnostic: true,
  detect: detectSourceLayout,
};
