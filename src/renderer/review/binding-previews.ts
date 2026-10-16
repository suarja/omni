import { useReviewRevision } from "./use-review-revision";
import { useEffect, useState } from "react";

import type { Binding, ProjectPlan } from "../../domain/assignment-plan";
import type { EntryRef } from "../../domain/project-source-registry";
import type { DesktopApi } from "../../shared/ipc";

export type BindingPreviewGroup = Readonly<{
  key: string;
  sourceId: string;
  packageId: string;
  artifactPath: string;
  kind: Binding["kind"];
  plans: readonly ProjectPlan[];
}>;

type PreviewApi = Pick<DesktopApi, "previewBindings" | "onReviewChanged"> | null | undefined;

function unitKey(binding: Binding): string {
  return `${binding.sourceId}:${binding.packageId}:${binding.artifactPath}:${binding.kind}`;
}

function groupedBindings(bindings: readonly Binding[]): readonly Binding[] {
  return [...bindings].sort(
    (left, right) =>
      unitKey(left).localeCompare(unitKey(right)) ||
      left.projectId.localeCompare(right.projectId) ||
      left.harnessId.localeCompare(right.harnessId),
  );
}

export function useBindingPreviews(
  api: PreviewApi,
  bindings: readonly Binding[],
  onEnsureGrant: (ref: EntryRef) => Promise<string | null>,
): readonly BindingPreviewGroup[] {
  const revision = useReviewRevision(api);
  const [groups, setGroups] = useState<readonly BindingPreviewGroup[]>([]);
  useEffect(() => {
    let active = true;
    const grouped = new Map<string, Binding[]>();
    for (const binding of groupedBindings(bindings))
      grouped.set(unitKey(binding), [...(grouped.get(unitKey(binding)) ?? []), binding]);
    setGroups((current) => (current.length ? [] : current));
    const previewBindings = api?.previewBindings;
    if (!previewBindings || !grouped.size)
      return () => {
        active = false;
      };
    void Promise.all(
      [...grouped.entries()].map(async ([key, unitBindings]) => {
        const first = unitBindings[0]!;
        const sourceGrantHandle = await onEnsureGrant({ kind: "source", id: first.sourceId });
        if (!sourceGrantHandle) return null;
        const projects = [];
        for (const projectId of [...new Set(unitBindings.map((binding) => binding.projectId))]) {
          const grantHandle = await onEnsureGrant({ kind: "project", id: projectId });
          if (!grantHandle) return null;
          projects.push({
            projectId,
            grantHandle,
            harnessIds: [
              ...new Set(
                unitBindings.filter((binding) => binding.projectId === projectId).map((binding) => binding.harnessId),
              ),
            ],
          });
        }
        const response = await previewBindings({
          source: { id: first.sourceId, grantHandle: sourceGrantHandle },
          packageId: first.packageId,
          artifactPath: first.artifactPath,
          projects,
        });
        return response.status === "ready"
          ? {
              key,
              sourceId: first.sourceId,
              packageId: first.packageId,
              artifactPath: first.artifactPath,
              kind: first.kind,
              plans: response.plans,
            }
          : null;
      }),
    )
      .then((results) => {
        if (active) setGroups(results.filter((result): result is BindingPreviewGroup => result !== null));
      })
      .catch(() => {
        if (active) setGroups((current) => (current.length ? [] : current));
      });
    return () => {
      active = false;
    };
  }, [api, bindings, onEnsureGrant, revision]);
  return groups;
}
