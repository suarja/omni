import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalJsonRegistryStore } from "../../adapters/registry/local-json";
import { activeWorkshop } from "../../domain/source-roles";
import { checkPublication } from "../../domain/publish-checks";
import { parsePublicationContentRequest } from "../../shared/storefront-presentation-ipc";
import type { PublicationPlanSummary } from "../../shared/publication-operations-ipc";
import { observedLayout } from "../operations-import-plan";
import { readRegularFile } from "../operation-files";
import { effectiveTree, manifestFrom } from "./publish-content";
import { readTree } from "./publish-context";
import { projectPublicationChecks } from "./publish-check-projection";

// Content checks are read-only. Only a complete destination-bound plan can authorize publication.
export async function readPublicationContentChecks(
  userDataPath: string,
  pluginId: string,
): Promise<PublicationPlanSummary> {
  parsePublicationContentRequest({ pluginId });
  const registry = await createLocalJsonRegistryStore(join(userDataPath, "omni/project-source-registry.json")).read();
  const workshop = registry.status === "ready" ? activeWorkshop(registry.state) : undefined;
  if (!workshop) throw new Error("Connect the active workshop before checking publication content.");
  const root = workshop.locator.canonicalPath;
  const layout = await observedLayout(root);
  const candidates =
    layout.packages?.filter((pkg) => pkg.displayName === pluginId || pkg.relativeRoot.split("/").at(-1) === pluginId) ??
    [];
  if (candidates.length !== 1) throw new Error("Select one observed workshop plugin before checking its content.");
  const folder = candidates[0]!.relativeRoot;
  const [raw, bytes] = await Promise.all([readTree(root, folder), readRegularFile(root, `${folder}/omni.plugin.json`)]);
  const manifest = manifestFrom(bytes);
  if (manifest.name !== pluginId) throw new Error("The plugin id must match its workshop manifest name.");
  const files = [
    ...projectPublicationChecks(effectiveTree(raw, manifest), `plugins/${pluginId}`),
    { path: "README.md", content: manifest.description ?? "" },
  ];
  return {
    files: [],
    conflicts: [],
    findings: [...checkPublication({ files, hasLicense: true, homeDirectory: homedir() })],
  };
}
