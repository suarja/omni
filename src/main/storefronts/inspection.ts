import { homedir } from "node:os";
import { githubDestinationRepository, redactStorefrontOrigin } from "../../domain/storefront-destination";
import { remoteUrl } from "../git-cli";
import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { detectSourceLayout } from "../../adapters/inventory/source-layout";
import { githubRepository, parseOriginRecord } from "../../domain/storefront-origin";
import type { SourceRegistration } from "../../domain/project-source-registry";
import type { StorefrontInspection } from "../../shared/storefronts-ipc";
import { optionalText } from "./files";
import { readGitText } from "../git-read";

export async function inspectStorefrontFolder(
  folder: string,
  workshop: SourceRegistration | undefined,
): Promise<StorefrontInspection> {
  const root = await realpath(folder);
  const filesystem = createLocalInventoryPort(root);
  const [repositoryRoot, originRemote, head, layout] = await Promise.all([
    readGitText(root, ["rev-parse", "--show-toplevel"]),
    remoteUrl(root).catch(() => undefined),
    readGitText(root, ["rev-parse", "--verify", "HEAD"]),
    detectSourceLayout(filesystem),
  ]);
  const isGitRepository = repositoryRoot !== undefined && (await realpath(repositoryRoot)) === root;
  const originUrl = originRemote ? redactStorefrontOrigin(originRemote, homedir()) : undefined;
  const repository = originUrl && githubDestinationRepository(originUrl);
  const workshopRoot = workshop?.locator.canonicalPath;
  const workshopRepository =
    workshopRoot && githubRepository((await readGitText(workshopRoot, ["config", "--get", "remote.origin.url"])) ?? "");
  const workshopPackages = workshopRoot
    ? ((await detectSourceLayout(createLocalInventoryPort(workshopRoot))).packages ?? [])
    : [];
  const plugins: StorefrontInspection["plugins"] = [];
  for (const pkg of layout.packages ?? []) {
    if (!/^plugins\/[^/]+$/u.test(pkg.relativeRoot) || !pkg.manifestPaths.length) continue;
    const text = await optionalText(filesystem, `${pkg.relativeRoot}/ORIGIN.md`);
    const origin = text === undefined ? undefined : parseOriginRecord(text);
    const recognized =
      origin !== undefined &&
      origin.sourceRepository.toLowerCase() === workshopRepository?.toLowerCase() &&
      workshopPackages.some((source) => source.relativeRoot === origin.sourcePath);
    plugins.push({
      pluginId: pkg.relativeRoot.slice("plugins/".length),
      name: pkg.displayName,
      relativeRoot: pkg.relativeRoot,
      manifestPaths: [...pkg.manifestPaths],
      ...(origin ? { origin } : {}),
      recognition: recognized ? "recognized" : "not-from-your-marketplace",
    });
  }
  let licenseFile: string | undefined;
  for (const file of await filesystem.listDirectory("")) {
    if (file.type === "file" && /^(?:licen[cs]e|copying)(?:\.(?:md|txt|rst))?$/iu.test(file.name)) {
      licenseFile = file.name;
      break;
    }
  }
  return {
    status: "ready",
    displayName: basename(root),
    isGitRepository,
    ...(repository ? { githubRepository: repository } : {}),
    ...(originUrl ? { originUrl } : {}),
    ...(licenseFile ? { licenseFile } : {}),
    ...(isGitRepository && head ? { storefrontCommit: head } : {}),
    plugins,
  };
}
