import { displayProjectRoot } from "../registry-display";
import type { StorefrontInspection } from "../../shared/storefronts-ipc";
import { readPluginDrift } from "./drift-reader";
import { join } from "node:path";
import { createLocalJsonRegistryStore } from "../../adapters/registry/local-json";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { detectSourceLayout } from "../../adapters/inventory/source-layout";
import { activeStorefronts, activeWorkshop } from "../../domain/source-roles";
import type { StorefrontDetails } from "../../shared/storefront-presentation-ipc";
import { createPublicationsStore, publicationsFilePath } from "./publications-store";
import { inspectStorefrontFolder } from "./inspection";
import { optionalText } from "./files";

export async function readStorefrontDetails(userDataPath: string, sourceId: string): Promise<StorefrontDetails> {
  const registry = await createLocalJsonRegistryStore(join(userDataPath, "omni/project-source-registry.json")).read();
  const saved = await createPublicationsStore(publicationsFilePath(userDataPath)).read();
  const source =
    registry.status === "ready"
      ? activeStorefronts(registry.state).find((source) => source.id === sourceId)
      : undefined;
  if (!source || registry.status !== "ready" || saved.status !== "ready")
    return {
      status: "blocked",
      code: "storefront-unavailable",
      message: "Reopen the active storefront before reading its publication details.",
      sourceId,
    };
  try {
    const filesystem = createLocalInventoryPort(source.locator.canonicalPath);
    const [inspection, layout] = await Promise.all([
      inspectStorefrontFolder(source.locator.canonicalPath, activeWorkshop(registry.state)),
      detectSourceLayout(filesystem),
    ]);
    const licenseText = inspection.licenseFile ? await optionalText(filesystem, inspection.licenseFile) : undefined;
    const license = licenseText?.includes("Apache License")
      ? "Apache-2.0"
      : licenseText?.includes("MIT License")
        ? "MIT"
        : inspection.licenseFile;
    return {
      status: "ready",
      inspection,
      publications: saved.publications.filter((publication) => publication.storefrontSourceId === sourceId),
      ...(layout.marketplace?.description
        ? { description: layout.marketplace.description.slice(0, 240).replace(/[\u0000-\u001f\u007f]/gu, " ") }
        : {}),
      ...(license ? { license } : {}),
    };
  } catch {
    return {
      status: "blocked",
      code: "storefront-read-failed",
      message: "The storefront could not be read safely. Restore access to its folder and read it again.",
      sourceId,
    };
  }
}

export async function readInspectionPresentation(
  userDataPath: string,
  root: string,
  inspection: StorefrontInspection,
): Promise<StorefrontInspection> {
  inspection = { ...inspection, displayRoot: displayProjectRoot(root) };
  if (
    !inspection.licenseFile &&
    !inspection.plugins.some((plugin) => plugin.recognition === "recognized" && plugin.origin)
  )
    return inspection;
  const registry = await createLocalJsonRegistryStore(join(userDataPath, "omni/project-source-registry.json")).read();
  if (registry.status !== "ready")
    throw new Error("The registry is unavailable. Recover it before inspecting publication details.");
  const workshopRoot = activeWorkshop(registry.state)?.locator.canonicalPath;
  const filesystem = createLocalInventoryPort(root);
  const text = inspection.licenseFile ? await optionalText(filesystem, inspection.licenseFile) : undefined;
  const license = text?.includes("Apache License")
    ? "Apache-2.0"
    : text?.includes("MIT License")
      ? "MIT"
      : inspection.licenseFile;
  const plugins = await Promise.all(
    inspection.plugins.map(async (plugin) => {
      if (plugin.recognition !== "recognized" || !plugin.origin) return plugin;
      const drift = await readPluginDrift(
        {
          storefrontSourceId: "inspection",
          pluginId: plugin.pluginId,
          workshopPackagePath: plugin.origin.sourcePath,
          baseCommit: plugin.origin.sourceCommit,
          publishedTime: plugin.origin.publishedTime,
          publishedHashes: {},
        },
        root,
        workshopRoot,
      );
      if (drift.status !== "ready") return { ...plugin, driftDiagnostic: drift.message };
      const behindSkills = new Set(
        drift.files
          .filter((file) => file.classification !== "unchanged" && file.classification !== "storefront-only")
          .flatMap((file) => file.path.match(/(?:^|\/)skills\/([^/]+)/u)?.[1] ?? []),
      ).size;
      return { ...plugin, behindSkills };
    }),
  );
  return { ...inspection, plugins, ...(license ? { license } : {}) };
}
