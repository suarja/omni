import { realpath } from "node:fs/promises";
import { registerSource } from "../../domain/project-source-registry";
import type { Publication } from "../../domain/publications";
import type { ProjectSourceRegistryStore } from "../../ports/project-source-registry";
import {
  parseStorefrontLinkResult,
  type StorefrontInspection,
  type StorefrontLinkResult,
} from "../../shared/storefronts-ipc";
import type { PublicationsStore } from "./publications-store";
import { readPluginHashes } from "./files";

async function prepareLinkedPublications(
  root: string,
  sourceId: string,
  inspection: StorefrontInspection,
  existing: readonly Publication[],
): Promise<Publication[]> {
  const incoming: Publication[] = [];
  for (const plugin of inspection.plugins) {
    if (
      plugin.recognition !== "recognized" ||
      !plugin.origin ||
      existing.some((record) => record.storefrontSourceId === sourceId && record.pluginId === plugin.pluginId)
    )
      continue;
    incoming.push({
      storefrontSourceId: sourceId,
      pluginId: plugin.pluginId,
      workshopPackagePath: plugin.origin.sourcePath,
      baseCommit: plugin.origin.sourceCommit,
      publishedHashes: await readPluginHashes(root, plugin.relativeRoot),
      ...(inspection.storefrontCommit ? { storefrontCommit: inspection.storefrontCommit } : {}),
      publishedTime: plugin.origin.publishedTime,
    });
  }
  return incoming;
}

export async function linkInspectedStorefront(
  path: string,
  inspection: StorefrontInspection,
  registry: ProjectSourceRegistryStore,
  publications: PublicationsStore,
  now: () => number,
): Promise<StorefrontLinkResult> {
  if (!inspection.isGitRepository)
    return {
      status: "blocked",
      code: "storefront-not-repository",
      message: "Select the root of an existing storefront Git repository.",
    };
  const [loaded, saved] = await Promise.all([registry.read(), publications.read()]);
  if (loaded.status !== "ready" || saved.status !== "ready")
    return {
      status: "blocked",
      code: "storefront-store-unavailable",
      message: "Recover the registry and publications store before linking.",
    };
  let registeredSourceId: string | undefined;
  try {
    const root = await realpath(path);
    const decision = registerSource(loaded.state, {
      displayName: inspection.displayName,
      canonicalPath: root,
      ownership: "personal",
      role: "storefront",
      createdAt: new Date(now()).toISOString(),
    });
    if (decision.result.status !== "ready")
      return {
        status: "blocked",
        code: "storefront-classification-conflict",
        message: "This folder already has a different source role. Keep its registration unchanged.",
      };
    const sourceId = decision.result.entry.ref.id;
    const incoming = await prepareLinkedPublications(root, sourceId, inspection, saved.publications);
    if (decision.result.outcome !== "existing") {
      const mutation = await registry.mutate(loaded.state.revision, () => decision.nextState);
      if (mutation.status !== "ready")
        return {
          status: "blocked",
          code: "registry-changed",
          message: "The registry changed while linking. Inspect the storefront again.",
        };
    }
    registeredSourceId = sourceId;
    const stored = incoming.length ? await publications.save(incoming) : saved;
    if (stored.status !== "ready") throw new Error("Publication persistence failed after storefront registration.");
    return parseStorefrontLinkResult({
      status: "linked",
      sourceId,
      inspection,
      publications: stored.publications.filter((record) => record.storefrontSourceId === sourceId),
    });
  } catch {
    return registeredSourceId
      ? {
          status: "blocked",
          code: "publications-save-failed",
          message:
            "The storefront is registered, but its publications could not be saved. Recover the store and retry linking.",
          sourceId: registeredSourceId,
        }
      : {
          status: "blocked",
          code: "storefront-inspection-failed",
          message: "The storefront link could not be completed safely. Inspect its folder and retry.",
        };
  }
}
