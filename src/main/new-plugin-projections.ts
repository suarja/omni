import { projectMarketplaceEntry, projectPluginManifest, type Harness } from "../domain/harness-projection";
import type { PackageManifest } from "../domain/marketplace-format";
import { harnessMarketplaces, indentationOf, json, manifestAction, type ManifestAction } from "./marketplace-manifests";

export class PluginProjectionError extends Error {
  constructor(
    readonly reason: "harness-marketplace-missing" | "harness-marketplace-invalid",
    message: string,
  ) {
    super(message);
  }
}

// Capture and skill creation share the same plugin layout and agent marketplace entries.
export async function buildNewPluginProjections(
  root: string,
  packagePath: string,
  manifest: PackageManifest,
  projectTo?: readonly Harness[],
  replacingPackagePath?: string,
): Promise<readonly ManifestAction[]> {
  return buildPluginProjectionActions(
    root,
    packagePath,
    manifest,
    await harnessMarketplaces(root),
    projectTo,
    replacingPackagePath,
  );
}

export function buildPluginProjectionActions(
  root: string,
  packagePath: string,
  manifest: PackageManifest,
  marketplaces: readonly import("./marketplace-manifests").HarnessMarketplace[],
  projectTo?: readonly Harness[],
  replacingPackagePath?: string,
): readonly ManifestAction[] {
  const harnesses = projectTo ?? marketplaces.map((entry) => entry.harness);
  const actions: ManifestAction[] = [];
  for (const harness of harnesses) {
    const marketplace = marketplaces.find((entry) => entry.harness === harness);
    if (!marketplace)
      throw new PluginProjectionError(
        "harness-marketplace-missing",
        `The ${harness === "claude-code" ? "Claude Code" : "Codex"} marketplace manifest is absent.`,
      );
    if (!Array.isArray(marketplace.manifest.plugins))
      throw new PluginProjectionError(
        "harness-marketplace-invalid",
        `The ${harness} marketplace manifest has no valid plugin list.`,
      );
    const entries = marketplace.manifest.plugins.filter((entry: unknown) => {
      if (!replacingPackagePath || typeof entry !== "object" || entry === null) return true;
      const source = (entry as Record<string, unknown>).source;
      const path =
        typeof source === "string"
          ? source
          : typeof source === "object" && source !== null && "path" in source
            ? source.path
            : undefined;
      return typeof path !== "string" || path.replace(/^\.\//u, "") !== replacingPackagePath;
    });
    if (
      entries.some(
        (entry: unknown) =>
          typeof entry === "object" && entry !== null && "name" in entry && entry.name === manifest.name,
      )
    )
      throw new Error("The agent marketplace already declares this plugin name.");
    const pluginPath = `${packagePath}/${harness === "claude-code" ? ".claude-plugin" : ".codex-plugin"}/plugin.json`;
    actions.push(manifestAction(root, pluginPath, json(projectPluginManifest(manifest, harness))));
    actions.push(
      manifestAction(
        root,
        marketplace.relativePath,
        json(
          {
            ...marketplace.manifest,
            plugins: [...entries, projectMarketplaceEntry(manifest, packagePath, harness)],
          },
          indentationOf(marketplace.content),
        ),
        marketplace.content,
      ),
    );
  }
  return actions;
}
