import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, join } from "node:path";
import type { RegistryState } from "../../domain/project-source-registry";
import type { OperationPlan } from "../../shared/operations-ipc";
import type { LinkStorefrontRequest } from "../../shared/storefront-link-ipc";
import { createLocalJsonRegistryStore } from "../../adapters/registry/local-json";
import { createStorefrontService } from "./service";
import { createPublicationsStore, publicationsFilePath } from "./publications-store";
import { readPluginHashes } from "./files";

function overlaps(left: string, right: string): boolean {
  const within = (root: string, path: string): boolean => {
    const delta = relative(root, path);
    return !delta || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith("../"));
  };
  return within(left, right) || within(right, left);
}
function assertSeparateStorefront(root: string, state: RegistryState): void {
  for (const source of state.sources) {
    if (!overlaps(source.locator.canonicalPath, root)) continue;
    if (source.ownership === "personal" && source.role === "storefront" && source.locator.canonicalPath === root)
      continue;
    const role = source.ownership === "external" ? "external" : (source.role ?? "workshop");
    throw new StorefrontLinkError(
      "storefront-classification-conflict",
      `This folder overlaps a registered ${role} source. Choose a separate storefront repository.`,
    );
  }
  if (state.projects.some((project) => overlaps(project.locator.canonicalPath, root)))
    throw new StorefrontLinkError(
      "storefront-classification-conflict",
      "This folder overlaps a registered project. Choose a separate storefront repository.",
    );
}

export class StorefrontLinkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function buildStorefrontLinkPlan(
  userDataPath: string,
  request: LinkStorefrontRequest,
): Promise<OperationPlan> {
  const registry = createLocalJsonRegistryStore(join(userDataPath, "omni/project-source-registry.json"));
  const publications = createPublicationsStore(publicationsFilePath(userDataPath));
  const [loaded, saved, node, root] = await Promise.all([
    registry.read(),
    publications.read(),
    lstat(request.path),
    realpath(request.path),
  ]);
  if (loaded.status !== "ready" || saved.status !== "ready")
    throw new StorefrontLinkError(
      "storefront-store-unavailable",
      "Recover the registry and publications store before linking.",
    );
  await publications.assertFresh();
  if (!node.isDirectory() || node.isSymbolicLink())
    throw new StorefrontLinkError(
      "storefront-folder-unavailable",
      "Select an accessible regular storefront directory.",
    );
  assertSeparateStorefront(root, loaded.state);
  const inspection = await createStorefrontService({ userDataPath }).inspect(root);
  if (inspection.status !== "ready") throw new StorefrontLinkError(inspection.code, inspection.message);
  if (!inspection.isGitRepository)
    throw new StorefrontLinkError(
      "storefront-not-repository",
      "Select the root of an existing storefront Git repository.",
    );
  const known = loaded.state.sources.find(
    (source) => source.locator.canonicalPath === root && source.role === "storefront",
  );
  const pluginHashes = await Promise.all(
    inspection.plugins.map(async (plugin) => [plugin.pluginId, await readPluginHashes(root, plugin.relativeRoot)]),
  );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        root,
        device: node.dev,
        inode: node.ino,
        registry: loaded.state,
        publications: saved.publications,
        inspection,
        pluginHashes,
      }),
    )
    .digest("hex");
  const unlinkedPlugins = inspection.plugins
    .filter((plugin) => plugin.recognition !== "recognized")
    .map((plugin) => ({
      pluginId: plugin.pluginId,
      reason: plugin.origin
        ? "ORIGIN.md does not match the active workshop repository and an available workshop plugin."
        : "ORIGIN.md is missing or invalid; no workshop source and base commit can be linked.",
    }));
  return {
    planId: randomUUID(),
    kind: "link-storefront",
    displayTarget: inspection.displayName,
    actions: [],
    git: { mode: "disabled", warnings: [] },
    storefrontLink: {
      path: root,
      action: known && !known.archivedAt ? "existing" : "link",
      ...(known ? { storefrontId: known.id } : {}),
      revision: loaded.state.revision,
      fingerprint,
      inspection,
      unlinkedPlugins,
    },
    notes: [
      `Link storefront ${inspection.displayName} (${root}). Nothing is written in the storefront folder. Undo archives the link.`,
      ...(request.reason ? [request.reason] : []),
    ],
  };
}
