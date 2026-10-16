import { describe, expect, it } from "vitest";
import type { InventorySnapshot } from "../../src/domain/inventory";
import { observationIssueForLocation } from "../../src/main/skill-reconciliation/location-observation";

function inventory(
  location: string,
  code: InventorySnapshot["diagnostics"][number]["code"] = "broken-link",
): InventorySnapshot {
  return {
    rootHandle: "project",
    displayRoot: "Project",
    observedAt: "2026-10-11T12:00:00.000Z",
    harnesses: [],
    artifacts: [],
    gitScopes: [],
    diagnostics: [{ location, code, severity: "warning", message: "Observation failed." }],
  };
}

describe("observation completeness for an exact folder", () => {
  it.each([".cursor/skills/old", ".agents/skills/demo-other", ".agents/skills/other/SKILL.md"])(
    "keeps a diagnostic at %s without blocking a separate skill",
    (path) => {
      const observed = inventory(path);
      expect(observationIssueForLocation(observed, ".agents/skills/demo")).toBeUndefined();
      expect(observed.diagnostics).toHaveLength(1);
    },
  );
  it.each([
    ".agents",
    ".agents/skills/",
    ".agents/skills/demo",
    ".agents/skills/demo/SKILL.md",
    ".agents/skills/demo/support/data",
    "",
    ".",
    "root",
    "/unknown",
    "../unknown",
    "claude-code",
  ])("blocks when %s affects the folder or has uncertain scope", (path) => {
    const observed = inventory(path);
    expect(observationIssueForLocation(observed, ".agents/skills/demo")).toBe(observed.diagnostics[0]);
  });
  it("keeps Git availability separate from exact tree observation", () => {
    expect(observationIssueForLocation(inventory("", "git-unavailable"), ".agents/skills/demo")).toBeUndefined();
  });
});
