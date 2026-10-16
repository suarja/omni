import type { AssignmentAction, Binding, ProjectPlan } from "../../domain/assignment-plan";
import { resolveTarget } from "../../domain/harness-targets";
import type { BindingsPreviewUnit } from "../../shared/bindings-ipc";
import type { SourceEntryView } from "../../domain/project-source-registry";

/**
 * Recovers the artifact a merged plan's action belongs to. A whole-plugin preview merges the
 * actions of every artifact of the package into one `ProjectPlan` per project, so saving needs
 * to find, for each action, which of the previewed units produced it — there can be several
 * units of the same kind (e.g. several skills). A blocked action already carries its unit's
 * artifact path verbatim (`assignment-plan.ts` sets it to the binding's own `artifactPath`); any
 * other action carries the deterministic target path `resolveTarget` computes from the unit's
 * `kind` and `id`, so recomputing it for each same-kind unit finds the match.
 */
export function unitForAction(
  units: readonly BindingsPreviewUnit[],
  action: AssignmentAction,
): BindingsPreviewUnit | undefined {
  const sameKind = units.filter((unit) => unit.kind === action.kind);
  if (action.state === "blocked") {
    return sameKind.find((unit) => unit.artifactPath === action.relativePath) ?? sameKind[0];
  }
  return (
    sameKind.find((unit) => {
      const target = resolveTarget({ kind: unit.kind, id: unit.id, harnessId: action.harnessId });
      return target.status === "target" && target.relativePath === action.relativePath;
    }) ?? sameKind[0]
  );
}

/** Builds the bindings to save from the previewed plans, matching each action back to its unit. */
export function buildBindingsToSave(
  plans: readonly ProjectPlan[],
  units: readonly BindingsPreviewUnit[],
  source: SourceEntryView,
  packageId: string,
  existingBindings: readonly Binding[] = [],
): readonly Binding[] {
  const existingById = new Map(existingBindings.map((binding) => [binding.bindingId, binding]));
  return plans.flatMap((plan) =>
    plan.actions.flatMap((action) => {
      const unit = unitForAction(units, action);
      if (!unit) return [];
      const bindingId = action.bindingId;
      const existing = existingById.get(bindingId);
      return [
        {
          ...existing,
          bindingId: action.bindingId,
          sourceId: source.ref.id,
          packageId,
          artifactPath: unit.artifactPath,
          kind: action.kind as Binding["kind"],
          projectId: plan.projectId,
          harnessId: action.harnessId,
          boundHash: existing?.boundHash ?? unit.contentHash,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        },
      ];
    }),
  );
}

export function assignmentPreviewFingerprint(
  plans: readonly ProjectPlan[],
  units: readonly BindingsPreviewUnit[],
): string {
  return JSON.stringify({
    plans: plans.map(({ projectId, planId, status, actions }) => ({ projectId, planId, status, actions })),
    units: units.map(({ artifactPath, kind, id, contentHash }) => ({
      artifactPath,
      kind,
      id,
      contentHash,
    })),
  });
}
