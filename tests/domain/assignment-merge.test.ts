import { describe, expect, it } from "vitest";

import { mergeProjectPlans } from "../../src/domain/assignment-merge";
import type { ProjectPlan } from "../../src/domain/assignment-plan";

function plan(overrides: Partial<ProjectPlan> = {}): ProjectPlan {
  return {
    projectId: "project-one",
    planId: "plan-skill",
    status: "ready",
    actions: [
      {
        bindingId: "binding-skill",
        harnessId: "claude-code",
        kind: "skill",
        relativePath: ".claude/skills/review",
        state: "add",
      },
    ],
    ...overrides,
  };
}

describe("mergeProjectPlans", () => {
  it("concatenates the actions of every unit plan for the same project", () => {
    const skillPlan = plan();
    const hookPlan = plan({
      planId: "plan-hook",
      status: "blocked",
      actions: [
        {
          bindingId: "binding-hook",
          harnessId: "claude-code",
          kind: "hook",
          relativePath: "hooks/hooks.json",
          state: "blocked",
          reason: "provider action (M4)",
        },
      ],
    });
    const merged = mergeProjectPlans([skillPlan, hookPlan]);
    expect(merged.projectId).toBe("project-one");
    expect(merged.actions.map((action) => action.bindingId).sort()).toEqual(["binding-hook", "binding-skill"]);
  });

  it("escalates status to blocked over conflict over ready", () => {
    expect(mergeProjectPlans([plan({ status: "ready" }), plan({ status: "ready" })]).status).toBe("ready");
    expect(mergeProjectPlans([plan({ status: "ready" }), plan({ status: "conflict" })]).status).toBe("conflict");
    expect(
      mergeProjectPlans([plan({ status: "conflict" }), plan({ status: "blocked" }), plan({ status: "ready" })]).status,
    ).toBe("blocked");
  });

  it("produces a deterministic planId independent of input order", () => {
    const first = mergeProjectPlans([plan({ planId: "a" }), plan({ planId: "b" })]);
    const second = mergeProjectPlans([plan({ planId: "b" }), plan({ planId: "a" })]);
    expect(first.planId).toBe(second.planId);
  });

  it("rejects an empty list and mismatched project ids", () => {
    expect(() => mergeProjectPlans([])).toThrow(/at least one plan/i);
    expect(() => mergeProjectPlans([plan(), plan({ projectId: "project-two" })])).toThrow(/same project/i);
  });
});
