import { useEffect, useState } from "react";
import {
  parseExternalComparison,
  type ExternalComparison,
  type ExternalSourceDetails,
  type ExternalUse,
} from "../../../shared/external-library-ipc";
import type { ResourceCanvasProps } from "../resource-canvas-types";

type Choice = Readonly<{ files: Readonly<Record<string, "mine" | "source">>; wholeCopy?: "mine" | "source" }>;
type Compared = Readonly<{ observation: string; evidence: string; comparison: ExternalComparison }>;
type Decision = Readonly<{ observation: string; evidence: string; choice: Choice }>;

function observationKey(details: ExternalSourceDetails | undefined, use: ExternalUse): string {
  const source = details?.source;
  return JSON.stringify([
    source?.id,
    source?.repo,
    source?.readCopy,
    source?.head?.commit,
    source?.lastError,
    use.id,
    use.sourceId,
    use.projectId,
    use.folderPath,
    use.skillPath,
    use.lockHash,
    use.copyHash,
    use.sourceHash,
    use.lockStale,
    use.installedCommit,
    use.base,
    use.state,
    use.sourceChanged,
    use.diagnostic,
  ]);
}

export function useExternalComparisons(
  api: ResourceCanvasProps["api"] | undefined,
  details: ExternalSourceDetails | undefined,
  uses: readonly ExternalUse[],
): Readonly<{
  comparisons: ReadonlyMap<string, ExternalComparison>;
  choices: ReadonlyMap<string, Choice>;
  errors: ReadonlyMap<string, string>;
  evidence: ReadonlyMap<string, string>;
  changeChoice: (useId: string, choice: Choice) => void;
}> {
  const observations = new Map(uses.map((use) => [use.id, observationKey(details, use)]));
  const key = JSON.stringify([...observations]);
  const [compared, setCompared] = useState<ReadonlyMap<string, Compared>>(new Map());
  const [decisions, setDecisions] = useState<ReadonlyMap<string, Decision>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let active = true;
    setCompared(new Map());
    setErrors(new Map());
    setDecisions(
      (current) => new Map([...current].filter(([id, decision]) => observations.get(id) === decision.observation)),
    );
    void Promise.allSettled(
      uses.map(async (use): Promise<Compared> => {
        if (!api?.compareExternalUse) throw new Error("Comparison is unavailable. Reopen the library.");
        const comparison = parseExternalComparison(await api.compareExternalUse({ useId: use.id }));
        if (comparison.useId !== use.id) throw new Error("Comparison response does not match the selected copy.");
        const observation = observations.get(use.id)!;
        return { observation, evidence: JSON.stringify([observation, comparison]), comparison };
      }),
    ).then((results) => {
      if (!active) return;
      const next = new Map<string, Compared>();
      const failures = new Map<string, string>();
      results.forEach((result, index) => {
        const id = uses[index]!.id;
        if (result.status === "fulfilled") next.set(id, result.value);
        else
          failures.set(
            id,
            result.reason instanceof Error ? result.reason.message : "External skill comparison failed.",
          );
      });
      setCompared(next);
      setErrors(failures);
      setDecisions(
        (current) => new Map([...current].filter(([id, decision]) => next.get(id)?.evidence === decision.evidence)),
      );
    });
    return () => {
      active = false;
    };
  }, [api, details, key]);
  const current = new Map([...compared].filter(([id, result]) => observations.get(id) === result.observation));
  return {
    comparisons: new Map([...current].map(([id, result]) => [id, result.comparison])),
    choices: new Map(
      [...decisions]
        .filter(([id, decision]) => current.get(id)?.evidence === decision.evidence)
        .map(([id, decision]) => [id, decision.choice]),
    ),
    errors,
    evidence: new Map([...current].map(([id, result]) => [id, result.evidence])),
    changeChoice(useId, choice) {
      const result = current.get(useId);
      if (result)
        setDecisions((previous) =>
          new Map(previous).set(useId, {
            observation: result.observation,
            evidence: result.evidence,
            choice,
          }),
        );
    },
  };
}
