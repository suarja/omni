import {
  parseExternalLibraryList,
  parseExternalSourceDetails,
  parseExternalComparison,
  parseExternalMacSources,
  type ExternalLibraryList,
  type ExternalSourceDetails,
  type ExternalComparison,
  type ExternalMacSources,
  type ExternalPass,
  type ExternalUse,
} from "../../shared/external-library-ipc";
import { classifyGitFailure } from "../git-command";
import { readExternalSourcesOnMac } from "./detection";
import type { ExternalLibraryObservation } from "./reader";
import { recoverExternalBase, type ExternalRecoveredBase } from "./base-recovery";
import { readExternalComparison } from "./comparison";
import { readBaseFiles } from "../git-read";
import { fingerprintExternalFiles } from "./trees";

export async function readExternalLibraryList(
  getObservation: () => Promise<ExternalLibraryObservation>,
  state: Readonly<{ lastPass?: ExternalPass; checking: boolean }>,
): Promise<ExternalLibraryList> {
  try {
    const observation = await getObservation();
    return parseExternalLibraryList({
      sources: observation.sources.map((entry) => entry.source!),
      ...state,
      diagnostics: observation.diagnostics,
    });
  } catch (error) {
    return { sources: [], ...state, diagnostics: [classifyGitFailure(error)] };
  }
}
export async function readExternalSourceDetails(
  getObservation: () => Promise<ExternalLibraryObservation>,
  id: string,
): Promise<ExternalSourceDetails> {
  try {
    const observation = await getObservation();
    return parseExternalSourceDetails(
      observation.sources.find((entry) => entry.source?.id === id) ?? {
        skills: [],
        uses: [],
        diagnostic: "The external source is unavailable. Check the library again.",
      },
    );
  } catch {
    return {
      skills: [],
      uses: [],
      diagnostic: "The external library could not be read. Restore its store and check again.",
    };
  }
}
export async function readExternalLibraryComparison(
  getObservation: () => Promise<ExternalLibraryObservation>,
  useId: string,
  cache: Map<string, Promise<ExternalRecoveredBase>>,
): Promise<ExternalComparison> {
  try {
    const observation = await getObservation();
    const use = observation.sources.flatMap((source) => source.uses).find((use) => use.id === useId);
    const locked = observation.lockedUses.find((entry) => entry.id === useId);
    const root = use && observation.roots.get(use.sourceId);
    if (use && locked && root && use.skillPath && use.state !== "unknown") {
      const head = observation.sources.find((source) => source.source?.id === use.sourceId)?.source?.head?.commit;
      if (!head) throw new Error("The external source has no verified HEAD.");
      const installedHash = use.lockStale ? use.copyHash! : use.lockHash;
      const key = JSON.stringify([use.sourceId, head, use.skillPath, installedHash]);
      let recovery = cache.get(key);
      if (!recovery) {
        recovery = readComparisonBase(root, use);
        cache.set(key, recovery);
      }
      const recovered = await recovery;
      return parseExternalComparison(
        await readExternalComparison({ ...use, base: recovered.base }, locked, root, recovered.files),
      );
    }
  } catch {
    /* Unavailable evidence is a read state, never a renderer exception. */
  }
  return {
    status: "unavailable",
    useId,
    base: { status: "unknown", reason: "The external use is unavailable. Check the library again." },
    files: [],
  };
}
async function readComparisonBase(root: string, use: ExternalUse): Promise<ExternalRecoveredBase> {
  if (!use.lockStale || !use.installedCommit) return recoverExternalBase(root, use.skillPath!, use.lockHash);
  const raw = await readBaseFiles(root, use.installedCommit, use.skillPath!);
  const files =
    raw &&
    Object.fromEntries(
      Object.entries(raw).filter(
        ([path]) => !path.split("/").some((part) => part === ".git" || part === "node_modules"),
      ),
    );
  if (!files || fingerprintExternalFiles(files) !== use.copyHash)
    return {
      base: { status: "unknown", reason: "The installed source version is unavailable. Check the source again." },
    };
  return { base: { status: "found", commit: use.installedCommit, scanned: 0 }, files };
}
export async function readExternalMacPresentation(
  options: Readonly<{ homeDir?: string; isPackaged?: boolean }>,
): Promise<ExternalMacSources> {
  try {
    return parseExternalMacSources(await readExternalSourcesOnMac(options));
  } catch {
    return {
      status: "unavailable",
      marketplaces: [],
      error: {
        type: "other",
        message: "The Claude Code marketplace list contains unsafe metadata. Repair it and try again.",
      },
    };
  }
}
