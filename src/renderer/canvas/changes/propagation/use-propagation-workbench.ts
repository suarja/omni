import { useCallback, useEffect, useState } from "react";
import type { SkillEffectStep, SkillResult } from "../../../../shared/skill-management-ipc";
import type { SkillPropagationIntent, SkillPropagationSummary } from "../../../../shared/skill-propagation-ipc";
import type { useSkillOperation } from "../use-skill-operation";
import { buildPropagationView, locationKey, selectPropagationIntent } from "./view-model";

type Context = Readonly<{
  summary: SkillPropagationSummary;
  steps: readonly SkillEffectStep[];
  intent?: SkillPropagationIntent;
  excluded: readonly string[];
}>;

function mergeContext(
  context: Context | null,
  summary: SkillPropagationSummary,
  steps: readonly SkillEffectStep[],
  intent: Context["intent"],
): Context {
  if (!context) return { summary, steps, intent, excluded: [] };
  const fresh = new Map(summary.targets.map((target) => [locationKey(target.location), target]));
  const reviewed = new Map(
    steps
      .filter((step) => step.propagationEvidence)
      .map((step) => [locationKey(step.propagationEvidence!.location), step]),
  );
  return {
    ...context,
    summary: {
      ...summary,
      targets: context.summary.targets.map((target) => fresh.get(locationKey(target.location)) ?? target),
    },
    steps: [
      ...context.steps.filter(
        (step) => !step.propagationEvidence || !reviewed.has(locationKey(step.propagationEvidence.location)),
      ),
      ...reviewed.values(),
    ],
  };
}

type PropagationWorkbenchState = Readonly<{
  summary: SkillPropagationSummary | undefined;
  steps: readonly SkillEffectStep[];
  selectedKeys: readonly string[] | undefined;
  view: ReturnType<typeof buildPropagationView> | null;
  select: (key: string, selected: boolean) => void;
  retainOriginal: () => void;
  retainResult: (result: SkillResult | undefined) => void;
  originals: readonly SkillResult[];
  openOriginal: (id: string) => void;
  clear: () => void;
}>;

export function usePropagationWorkbench(operation: ReturnType<typeof useSkillOperation>): PropagationWorkbenchState {
  const [context, setContext] = useState<Context | null>(null);
  const [originals, setOriginals] = useState<readonly SkillResult[]>([]);
  const preview = operation.preview?.status === "ready" ? operation.preview : null;
  const intent =
    operation.intent?.kind === "update-and-maintain" || operation.intent?.kind === "maintain-current"
      ? operation.intent
      : undefined;
  useEffect(() => {
    if (!preview?.propagation) return;
    setContext((previous) => mergeContext(previous, preview.propagation!, preview.steps, intent));
    if (
      intent?.kind === "update-and-maintain" &&
      !buildPropagationView(preview.propagation, preview.steps).selectedCopyCount
    )
      void operation.inspect({ kind: "write", request: intent.request });
  }, [preview, intent, operation.inspect]);
  const active =
    context ??
    (preview?.propagation ? { summary: preview.propagation, steps: preview.steps, intent, excluded: [] } : null);
  const summary = active?.summary ?? operation.result?.propagation;
  const steps = active?.steps ?? [];
  const defaults = summary ? buildPropagationView(summary, steps) : null;
  const selectedKeys = defaults?.locations
    .filter((item) => item.selectable && !active?.excluded.includes(item.key))
    .map((item) => item.key);
  const view = summary ? buildPropagationView(summary, steps, selectedKeys, operation.result ?? undefined) : null;

  const select = (key: string, selected: boolean): void => {
    if (!active?.intent || operation.busy) return;
    const excluded = selected ? active.excluded.filter((item) => item !== key) : [...active.excluded, key];
    setContext({ ...active, excluded });
    const locations = defaults!.locations
      .filter((item) => item.selectable && !excluded.includes(item.key))
      .map((item) => item.target.location);
    const next = selectPropagationIntent(active.intent, locations);
    if (next) void operation.inspect(next);
    else operation.clearReview();
  };
  const retainOriginal = (): void => {
    if (operation.result)
      setOriginals((saved) =>
        saved.some((item) => item.intentId === operation.result!.intentId) ? saved : [...saved, operation.result!],
      );
    setContext(null);
  };
  const retainResult = useCallback((result: SkillResult | undefined): void => {
    if (!result?.propagation) return;
    setContext({ summary: result.propagation, steps: [], excluded: [] });
  }, []);
  const openOriginal = (id: string): void => {
    retainOriginal();
    setContext(null);
    operation.clearReview();
    void operation.loadResult(id);
  };
  return {
    summary,
    steps,
    selectedKeys,
    view,
    select,
    retainOriginal,
    retainResult,
    originals,
    openOriginal,
    clear: (): void => setContext(null),
  };
}
