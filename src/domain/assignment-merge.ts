import { createHash } from "node:crypto";

import type { ProjectPlan } from "./assignment-plan";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergedStatus(plans: readonly ProjectPlan[]): ProjectPlan["status"] {
  if (plans.some((plan) => plan.status === "blocked")) return "blocked";
  if (plans.some((plan) => plan.status === "conflict")) return "conflict";
  return "ready";
}

function mergedPlanId(plans: readonly ProjectPlan[]): string {
  const canonical = [...plans.map((plan) => plan.planId)].sort(compare).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Concatenates the per-unit plans of a single project (one `planAssignment` call per artifact of
 * a whole-plugin assignment) into the single `ProjectPlan` the assignment page renders. Every
 * plan must share the same `projectId`; the merged status escalates to the worst of the inputs
 * (blocked over conflict over ready), matching how a single plan already reports its own status.
 */
export function mergeProjectPlans(plans: readonly ProjectPlan[]): ProjectPlan {
  if (!plans.length) throw new Error("mergeProjectPlans requires at least one plan.");
  const projectId = plans[0]!.projectId;
  if (plans.some((plan) => plan.projectId !== projectId))
    throw new Error("mergeProjectPlans requires plans for the same project.");
  const actions = plans
    .flatMap((plan) => plan.actions)
    .sort(
      (left, right) =>
        compare(left.harnessId, right.harnessId) ||
        compare(left.relativePath, right.relativePath) ||
        compare(left.bindingId, right.bindingId),
    );
  return { projectId, planId: mergedPlanId(plans), status: mergedStatus(plans), actions };
}
