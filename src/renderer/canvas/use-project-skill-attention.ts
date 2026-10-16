import { useEffect, useMemo, useState } from "react";

import { aggregateSkillAttention, deriveSkillAttention } from "../../domain/skill-reconciliation/attention";
import type { SkillAttentionSummary } from "../../domain/skill-reconciliation/attention";
import type { CanvasProjectAttention, CanvasSession } from "./spatial/spatial-types";
import type { SkillCopiesState } from "./use-skill-copies";

type ProjectRoot = Readonly<{ projectId: string; rootKey: string }>;
type Inputs = Readonly<{
  projectId?: string;
  roots: readonly ProjectRoot[];
  observationKey?: string;
  observedAt?: string;
  skillCopies: SkillCopiesState;
  session: CanvasSession;
}>;

function summarizeObservation(state: Extract<SkillCopiesState, { status: "ready" }>): SkillAttentionSummary {
  return aggregateSkillAttention([
    ...[...state.byGroup.values()].flatMap((correlation) =>
      correlation.groups.map((group) => deriveSkillAttention(group.locations)),
    ),
    ...state.retainedSkills.map((retained) => deriveSkillAttention(retained.locations)),
  ]);
}

function failObservation(previous: CanvasProjectAttention | undefined): SkillAttentionSummary {
  return aggregateSkillAttention([
    ...(previous ? [{ state: previous.state, reasons: previous.reasons }] : []),
    { state: "unavailable", reasons: ["unavailable"] },
  ]);
}

export function useProjectSkillAttention(input: Inputs): ReadonlyMap<string, SkillAttentionSummary> {
  const [sessionRevision, setSessionRevision] = useState(0);
  const rootsById = useMemo(() => new Map(input.roots.map((root) => [root.projectId, root.rootKey])), [input.roots]);
  const rootKey = input.projectId ? rootsById.get(input.projectId) : undefined;
  const saved = useMemo(() => input.session.listProjectAttention(), [input.session, sessionRevision]);
  const previous = input.projectId
    ? saved.find((item) => item.projectId === input.projectId && item.rootKey === rootKey)
    : undefined;
  const observed = useMemo(
    () => (input.skillCopies.status === "ready" ? summarizeObservation(input.skillCopies) : undefined),
    [input.skillCopies],
  );
  const summary = useMemo(
    () => observed ?? (input.skillCopies.status === "unavailable" ? failObservation(previous) : previous),
    [input.skillCopies.status, observed, previous],
  );
  const current = useMemo(() => {
    const canStoreObservation = input.skillCopies.status === "ready" || input.skillCopies.status === "unavailable";
    if (!canStoreObservation || !input.projectId || !rootKey || !input.observationKey || !summary) return undefined;
    return {
      projectId: input.projectId,
      rootKey,
      observationKey: input.observationKey,
      freshness: input.skillCopies.status === "ready" ? ("fresh" as const) : ("failed" as const),
      observedAt: input.observedAt ?? input.observationKey,
      ...summary,
    };
  }, [input.observationKey, input.observedAt, input.projectId, input.skillCopies.status, rootKey, summary]);

  useEffect(() => {
    const roots = input.roots;
    const before = input.session.listProjectAttention();
    input.session.retainProjectAttention(roots);
    if (current) input.session.writeProjectAttention(current);
    const after = input.session.listProjectAttention();
    if (JSON.stringify(before) !== JSON.stringify(after)) setSessionRevision((revision) => revision + 1);
  }, [current, input.roots, input.session]);

  return useMemo(() => {
    const result = new Map<string, SkillAttentionSummary>();
    for (const attention of saved) {
      if (rootsById.get(attention.projectId) === attention.rootKey && attention.state !== "quiet") {
        result.set(attention.projectId, { state: attention.state, reasons: attention.reasons });
      }
    }
    if (current && current.state !== "quiet")
      result.set(current.projectId, { state: current.state, reasons: current.reasons });
    return result;
  }, [current, rootsById, saved]);
}
