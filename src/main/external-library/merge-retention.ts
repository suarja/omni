import { basename, join } from "node:path";
import type { ExternalUse } from "../../shared/external-library-ipc";
import type { ExternalSkillEvidence } from "../../shared/external-skill-effects";
import { createOperationStore } from "../operation-store";
import { readExternalBackup } from "./operation-files";
import { fingerprintExternalFiles } from "./trees";
import type { ExternalLibraryObservation } from "./reader";

type RetainedCopy = Readonly<{ name: string; path: string; sourceHash: string; copyHash: string }>;
const key = (use: Pick<ExternalUse, "sourceId" | "projectId" | "skillKey" | "skillPath">): string =>
  JSON.stringify([use.sourceId, use.projectId, use.skillKey, use.skillPath]);

function counts(
  uses: readonly ExternalUse[],
): NonNullable<ExternalLibraryObservation["sources"][number]["source"]>["counts"] {
  return {
    "up-to-date": uses.filter((use) => use.state === "up-to-date").length,
    update: uses.filter((use) => use.state === "update").length,
    modified: uses.filter((use) => use.state === "modified").length,
    removed: uses.filter((use) => use.state === "removed").length,
    unknown: uses.filter((use) => use.state === "unknown").length,
  };
}
const pair = (use: Pick<ExternalUse, "sourceId" | "projectId">): string =>
  JSON.stringify([use.sourceId, use.projectId]);
const targetKey = (use: Pick<ExternalUse, "sourceId" | "projectId" | "skillKey">): string =>
  JSON.stringify([use.sourceId, use.projectId, use.skillKey]);
export function createExternalMergeRetention(userDataPath: string): Readonly<{
  observe(observation: ExternalLibraryObservation): Promise<ExternalLibraryObservation>;
}> {
  const store = createOperationStore(join(userDataPath, "omni/operations.json"));
  const cache = new Map<string, Promise<readonly RetainedCopy[]>>();
  const read = (evidence: ExternalSkillEvidence): Promise<readonly RetainedCopy[]> => {
    const cacheKey = evidence.backupPath + ":" + evidence.backupHash;
    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = readExternalBackup({ userDataPath }, evidence)
        .then(({ backup }) =>
          backup.layouts.flatMap((layout) => {
            if (layout.after?.[0]?.kind !== "directory") return [];
            const files: Record<string, Uint8Array> = Object.create(null);
            for (const entry of layout.after)
              if (
                entry.kind === "file" &&
                !entry.path.split("/").some((part) => part === ".git" || part === "node_modules")
              )
                files[entry.path] = Buffer.from(entry.data, "base64");
            const copyHash = fingerprintExternalFiles(files);
            return backup.sources
              .filter((source) => source.hash !== copyHash)
              .map((source) => ({ name: basename(layout.path), path: source.path, sourceHash: source.hash, copyHash }));
          }),
        )
        .catch((error: unknown) => {
          cache.delete(cacheKey);
          throw error;
        });
      cache.set(cacheKey, pending);
    }
    return pending;
  };
  return {
    observe: async (observation) => {
      const history = await store.read();
      const uses = observation.sources.flatMap((source) => source.uses);
      const unavailable = new Set<string>(),
        diagnostics = [...observation.diagnostics];
      const retained = new Map<string, RetainedCopy>();
      if (history.status !== "ready") {
        for (const use of uses) unavailable.add(targetKey(use));
        diagnostics.push({
          type: "other",
          message: "Operation History is unavailable. Repair it before updating external copies.",
        });
      } else
        for (const receipt of history.receipts) {
          const evidence = receipt.externalSkill;
          if (
            receipt.kind !== "merge-external-skill" ||
            receipt.restored ||
            evidence?.direction !== "forward" ||
            !uses.some((use) => pair(use) === pair(evidence))
          )
            continue;
          try {
            for (const copy of await read(evidence))
              retained.set(
                key({
                  sourceId: evidence.sourceId,
                  projectId: evidence.projectId,
                  skillKey: copy.name,
                  skillPath: copy.path,
                }),
                copy,
              );
          } catch {
            for (const layout of evidence.layouts)
              unavailable.add(
                targetKey({
                  sourceId: evidence.sourceId,
                  projectId: evidence.projectId,
                  skillKey: basename(layout.path),
                }),
              );
            diagnostics.push({
              type: "other",
              message: `${evidence.sourceId}, project ${evidence.projectId}: a saved merge backup is unavailable. Restore it in History before updating this copy.`,
            });
          }
        }
      // A deliberate kept edit may equal a past publication. Its receipt distinguishes it from a foreign lock.
      return {
        ...observation,
        diagnostics,
        sources: observation.sources.map((source) => {
          const uses = source.uses.map((use) => {
            if (unavailable.has(targetKey(use)))
              return {
                ...use,
                state: "unknown" as const,
                diagnostic: "Saved merge evidence is unavailable. Repair operation History and check again.",
              };
            const copy = retained.get(key(use));
            if (
              !copy ||
              !use.copyHash ||
              use.copyHash === copy.sourceHash ||
              use.lockHash !== copy.sourceHash ||
              use.state === "unknown" ||
              use.state === "removed" ||
              use.copyHash === use.sourceHash
            )
              return use;
            const { lockStale: _stale, installedCommit: _installed, ...current } = use;
            return { ...current, state: "modified" as const, sourceChanged: use.sourceHash !== use.lockHash };
          });
          return { ...source, uses, ...(source.source ? { source: { ...source.source, counts: counts(uses) } } : {}) };
        }),
      };
    },
  };
}
