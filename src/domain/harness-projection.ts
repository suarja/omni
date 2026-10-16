import type { PackageManifest } from "./marketplace-format";

export type Harness = "claude-code" | "codex";

export type ProjectedPluginManifest = Readonly<Record<string, unknown>>;
export type ProjectedMarketplaceEntry = Readonly<Record<string, unknown>>;

function hasSkills(omniPackage: PackageManifest): boolean {
  return omniPackage.artifacts.some((artifact) => artifact.kind === "skill");
}

function packageMetadata(omniPackage: PackageManifest): Record<string, string> {
  return {
    name: omniPackage.name,
    version: omniPackage.version,
    ...(omniPackage.description ? { description: omniPackage.description } : {}),
  };
}

function assertHarness(harness: string): asserts harness is Harness {
  if (harness !== "claude-code" && harness !== "codex") throw new Error(`Unsupported harness: ${harness}.`);
}

export function projectPluginManifest(omniPackage: PackageManifest, harness: Harness): ProjectedPluginManifest {
  assertHarness(harness);
  const metadata = packageMetadata(omniPackage);
  return harness === "codex" && hasSkills(omniPackage) ? { ...metadata, skills: "./skills/" } : metadata;
}

export function projectMarketplaceEntry(
  omniPackage: PackageManifest,
  packagePath: string,
  harness: Harness,
): ProjectedMarketplaceEntry {
  assertHarness(harness);
  const sourcePath = packagePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!sourcePath || sourcePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Package path must be a safe relative path.");
  }
  const metadata = packageMetadata(omniPackage);
  if (harness === "claude-code") return { ...metadata, source: `./${sourcePath}` };
  return {
    ...metadata,
    source: { source: "local", path: `./${sourcePath}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
}
