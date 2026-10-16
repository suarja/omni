import { join } from "node:path";
import { createLocalJsonRegistryStore } from "../../adapters/registry/local-json";
import { activeWorkshop } from "../../domain/source-roles";
import {
  parseStorefrontDriftReport,
  type StorefrontBlocked,
  type StorefrontDriftReport,
  type StorefrontInspection,
  type StorefrontLinkResult,
} from "../../shared/storefronts-ipc";
import { createPublicationsStore, publicationsFilePath } from "./publications-store";
import { inspectStorefrontFolder } from "./inspection";
import { linkInspectedStorefront } from "./linker";
import { readPublicationDrift } from "./drift-reader";

type StorefrontService = Readonly<{
  inspect(path: string): Promise<StorefrontInspection | StorefrontBlocked>;
  link(path: string): Promise<StorefrontLinkResult>;
  readDrift(): Promise<StorefrontDriftReport>;
}>;
function blocked(code: string, message: string, sourceId?: string): StorefrontBlocked {
  return { status: "blocked", code, message, ...(sourceId ? { sourceId } : {}) };
}

export function createStorefrontService(
  options: Readonly<{ userDataPath: string; now?: () => number }>,
): StorefrontService {
  const registry = createLocalJsonRegistryStore(join(options.userDataPath, "omni/project-source-registry.json"));
  const publications = createPublicationsStore(publicationsFilePath(options.userDataPath));
  const inspect = async (path: string): Promise<StorefrontInspection | StorefrontBlocked> => {
    const loaded = await registry.read();
    if (loaded.status !== "ready")
      return blocked("registry-unavailable", "The registry is unavailable. Recover it before linking a storefront.");
    try {
      return await inspectStorefrontFolder(path, activeWorkshop(loaded.state));
    } catch {
      return blocked(
        "storefront-inspection-failed",
        "The storefront could not be read safely. Select an accessible regular directory.",
      );
    }
  };
  let linkQueue = Promise.resolve();
  const link = (path: string): Promise<StorefrontLinkResult> => {
    const operation = linkQueue.then(async () => {
      const inspection = await inspect(path);
      return inspection.status === "ready"
        ? linkInspectedStorefront(path, inspection, registry, publications, options.now ?? Date.now)
        : inspection;
    });
    linkQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  const readDrift = async (): Promise<StorefrontDriftReport> => {
    const [loaded, saved] = await Promise.all([registry.read(), publications.read()]);
    if (loaded.status !== "ready" || saved.status !== "ready")
      return blocked(
        "storefront-store-unavailable",
        "Recover the registry and publications store to read publication drift.",
      );
    return parseStorefrontDriftReport(await readPublicationDrift(loaded.state, saved.publications));
  };
  return { inspect, link, readDrift };
}
