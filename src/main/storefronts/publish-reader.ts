import type { PackageManifest } from "../../domain/marketplace-format";
import { githubRepository } from "../../domain/storefront-origin";
import type { PublishPluginRequest } from "../../shared/publication-operations-ipc";
import { observedLayout } from "../operations-import-plan";
import { readRegularFile } from "../operation-files";
import { hashes, sameHashes, readTree, type FileTree, type PublicationOptions } from "./publish-context";
import { readBaseFiles, readGitText } from "../git-read";
import { manifestFrom } from "./publish-content";
export type WorkshopEvidence = Readonly<{
  packagePath: string;
  raw: FileTree;
  omni: Uint8Array | undefined;
  workshopCommit: string;
  repository: string;
  manifest: PackageManifest;
}>;
export async function readWorkshopEvidence(
  options: PublicationOptions,
  request: PublishPluginRequest,
  workshopRoot: string,
): Promise<WorkshopEvidence> {
  const layout = await observedLayout(workshopRoot);
  const candidates =
    layout.packages?.filter(
      (pkg) => pkg.displayName === request.pluginId || pkg.relativeRoot.split("/").at(-1) === request.pluginId,
    ) ?? [];
  if (candidates.length !== 1) throw new Error("Select one observed workshop plugin to publish.");
  const packagePath = candidates[0]!.relativeRoot;
  const [raw, omni, workshopCommit, repository] = await Promise.all([
    readTree(workshopRoot, packagePath),
    readRegularFile(workshopRoot, `${packagePath}/omni.plugin.json`),
    options.git.headCommit(workshopRoot),
    readGitText(workshopRoot, ["config", "--get", "remote.origin.url"]),
  ]);
  if (!workshopCommit || !repository || !githubRepository(repository))
    throw new Error("The workshop needs a committed revision and a GitHub origin identity for ORIGIN.md.");
  const committed = await readBaseFiles(workshopRoot, workshopCommit, packagePath);
  if (!committed || !sameHashes(hashes({ ...raw, ...(omni ? { "omni.plugin.json": omni } : {}) }), hashes(committed)))
    throw new Error("Commit the workshop plugin before publishing so its base revision matches the published files.");
  const manifest = manifestFrom(omni);
  if (manifest.name !== request.pluginId) throw new Error("The plugin id must match its workshop manifest name.");
  return { packagePath, raw, omni, workshopCommit, repository, manifest };
}
