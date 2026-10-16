import { useEffect, useState } from "react";
import { parseExternalComparison, type ExternalUse } from "../../../shared/external-library-ipc";
import type { ResourceCanvasProps } from "../resource-canvas-types";

type Count = Readonly<{ files?: number; missingBase?: boolean; error?: string }>;

export function useComparisonCounts(
  api: ResourceCanvasProps["api"],
  sourceHead: string | undefined,
  uses: readonly ExternalUse[],
): ReadonlyMap<string, Count> {
  const key = JSON.stringify([
    sourceHead,
    uses.map((use) => [
      use.id,
      use.copyHash,
      use.sourceHash,
      use.lockHash,
      use.state,
      use.lockStale,
      use.installedCommit,
      use.base,
    ]),
  ]);
  const [result, setResult] = useState<Readonly<{ key: string; counts: ReadonlyMap<string, Count> }>>({
    key: "",
    counts: new Map(),
  });
  useEffect(() => {
    let active = true;
    let next = 0;
    const counts = new Map<string, Count>();
    async function read(): Promise<void> {
      while (active && next < uses.length) {
        const use = uses[next++]!;
        let count: Count;
        try {
          if (!api?.compareExternalUse) throw new Error("Comparison is unavailable. Reopen the library.");
          const comparison = parseExternalComparison(await api.compareExternalUse({ useId: use.id }));
          if (comparison.useId !== use.id) throw new Error("Comparison response does not match the requested copy.");
          count =
            comparison.status === "ready"
              ? {
                  files: comparison.files.filter(
                    (file) => file.classification === "storefront-only" || file.classification === "conflict",
                  ).length,
                }
              : comparison.base.status === "not-found"
                ? { missingBase: true }
                : { error: comparison.diagnostic ?? "Comparison is unavailable. Check the library again." };
        } catch (failure) {
          count = { error: failure instanceof Error ? failure.message : "Comparison failed. Check the library again." };
        }
        if (active) {
          counts.set(use.id, count);
          setResult({ key, counts: new Map(counts) });
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, uses.length) }, () => read()));
    return () => {
      active = false;
    };
  }, [api, key]);
  return result.key === key ? result.counts : new Map();
}
