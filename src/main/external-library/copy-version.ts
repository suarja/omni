import type { ExternalCopyVersion } from "../../domain/external-sources";
import type { ExternalUse } from "../../shared/external-library-ipc";
import { classifyExternalUse } from "../../domain/external-library";
import { recoverExternalBase } from "./base-recovery";
import type { ExternalSourcesStore } from "./store";

export type ExternalCopyVersionResolver = (use: ExternalUse, root: string, head: string) => Promise<ExternalUse>;
function versionKey(repo: string, path: string, hash: string): string {
  return JSON.stringify([repo, path, hash]);
}
export async function createExternalCopyVersionResolver(
  store: ExternalSourcesStore,
): Promise<ExternalCopyVersionResolver> {
  const cache = new Map<string, ExternalCopyVersion>(
    (await store.read()).copyVersions?.map((entry) => [versionKey(entry.repo, entry.skillPath, entry.copyHash), entry]),
  );
  return async (use, root, head) => {
    if (use.state === "unknown" || !use.copyHash || !use.skillPath || use.copyHash === use.lockHash) return use;
    const key = versionKey(use.sourceId, use.skillPath, use.copyHash);
    let version = cache.get(key);
    if (use.copyHash === use.sourceHash) {
      version = {
        repo: use.sourceId,
        skillPath: use.skillPath,
        copyHash: use.copyHash,
        head,
        result: { status: "found", commit: head },
      };
    } else if (!version || (version.result.status === "not-found" && version.head !== head)) {
      const recovered = await recoverExternalBase(root, use.skillPath, use.copyHash, 300, {
        sinceCommit: version?.result.status === "not-found" ? version.head : undefined,
      });
      if (recovered.base.status === "unknown") return use;
      version = {
        repo: use.sourceId,
        skillPath: use.skillPath,
        copyHash: use.copyHash,
        head,
        result:
          recovered.base.status === "found"
            ? { status: "found", commit: recovered.base.commit }
            : {
                status: "not-found",
                bounded: recovered.base.bounded,
                ...(recovered.base.reason ? { reason: recovered.base.reason } : {}),
              },
      };
    }
    if (cache.get(key) !== version) {
      await store.cacheCopyVersion(version);
      cache.set(key, version);
    }
    if (version.result.status !== "found") return use;
    return {
      ...use,
      ...classifyExternalUse({
        lock: use.copyHash,
        copy: use.copyHash,
        source: use.sourceHash,
        removed: use.state === "removed",
      }),
      lockStale: true,
      installedCommit: version.result.commit,
    };
  };
}
