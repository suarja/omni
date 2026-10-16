import type { RegistryState } from "../../domain/project-source-registry";
import type { Publication } from "../../domain/publications";
import { activeStorefronts, activeWorkshop } from "../../domain/source-roles";
import {
  classifyPublicationDrift,
  emptyPublicationCounts,
  publicationClassifications,
} from "../../domain/publication-drift";
import type { StorefrontDriftReport, StorefrontPluginDrift } from "../../shared/storefronts-ipc";
import { readBaseHashes } from "../git-read";
import { readPluginHashes } from "./files";

export async function readPluginDrift(
  publication: Publication,
  storefrontRoot: string,
  workshopRoot: string | undefined,
): Promise<StorefrontPluginDrift> {
  const { pluginId } = publication;
  if (!workshopRoot)
    return {
      status: "unavailable",
      pluginId,
      code: "workshop-unavailable",
      message: "Connect the workshop to compare this publication.",
    };
  try {
    const base = await readBaseHashes(workshopRoot, publication.baseCommit, publication.workshopPackagePath);
    if (!base)
      return {
        status: "missing-base",
        pluginId,
        code: "base-commit-missing",
        message: "The published workshop commit is unavailable. Restore access to its Git history.",
      };
    const [storefront, workshop] = await Promise.all([
      readPluginHashes(storefrontRoot, `plugins/${pluginId}`),
      readPluginHashes(workshopRoot, publication.workshopPackagePath),
    ]);
    const drift = classifyPublicationDrift(base, storefront, workshop);
    return { status: "ready", pluginId, ...drift, files: [...drift.files] };
  } catch {
    return {
      status: "unavailable",
      pluginId,
      code: "publication-files-unavailable",
      message: "Publication files could not be read safely. Reopen the storefront and workshop.",
    };
  }
}

export async function readPublicationDrift(
  registry: RegistryState,
  publications: readonly Publication[],
): Promise<StorefrontDriftReport> {
  const workshopRoot = activeWorkshop(registry)?.locator.canonicalPath;
  const storefronts: Extract<StorefrontDriftReport, { status: "ready" }>["storefronts"] = [];
  for (const storefront of activeStorefronts(registry)) {
    const plugins: StorefrontPluginDrift[] = [];
    for (const publication of publications.filter((record) => record.storefrontSourceId === storefront.id))
      plugins.push(await readPluginDrift(publication, storefront.locator.canonicalPath, workshopRoot));
    const counts = emptyPublicationCounts();
    for (const plugin of plugins)
      if (plugin.status === "ready")
        for (const classification of publicationClassifications)
          counts[classification] += plugin.counts[classification];
    const behindPlugins = plugins.filter((plugin) => plugin.status === "ready" && plugin.behind).length;
    storefronts.push({
      sourceId: storefront.id,
      name: storefront.displayName,
      plugins,
      counts,
      behind: behindPlugins > 0,
      behindPlugins,
      unavailablePlugins: plugins.filter((plugin) => plugin.status !== "ready").length,
      toPublish: counts["workshop-changed"] + counts["added-in-workshop"] + counts["removed-in-workshop"],
      conflicts: counts.conflict,
    });
  }
  return { status: "ready", storefronts };
}
