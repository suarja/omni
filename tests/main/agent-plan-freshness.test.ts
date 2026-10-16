import { expect, it } from "vitest";
import { samePlan } from "../../src/shared/agent-plan-freshness";
import type { OperationPlan } from "../../src/shared/operations-ipc";
const plan: OperationPlan = {
  planId: "one",
  kind: "make-compatible",
  displayTarget: "Personal",
  actions: [{ kind: "write-file", relativePath: "omni.plugin.json", diff: "-old\n+new" }],
  git: { mode: "unavailable", warnings: [] },
};
it("requires review when a legacy manifest diff changes without exposed hashes", () => {
  expect(samePlan(plan, { ...plan, planId: "two", actions: [{ ...plan.actions[0]!, diff: "-edited\n+new" }] })).toBe(
    false,
  );
});
it("ignores regenerated plan ids when displayed effects remain equal", () => {
  expect(samePlan(plan, { ...plan, planId: "two" })).toBe(true);
});
