import { describe, expect, it } from "vitest";

// The benchmark helpers are intentionally plain Node ESM; the test exercises their runtime contract.
// @ts-expect-error No declaration file is needed for this small script-only module.
import { formatBenchmarkTable, overlapPercentage, reasonLanguage } from "../../scripts/ai-bench-lib.mjs";

describe("AI benchmark helpers", () => {
  it("calculates overlap against the deterministic top five", () => {
    expect(
      overlapPercentage(
        [
          { ownerRepo: "a", skill: "one" },
          { ownerRepo: "b", skill: "two" },
        ],
        ["a/one", "b/two", "c/three", "d/four", "e/five"],
      ),
    ).toBe(40);
  });

  it("detects the language of model reasons", () => {
    expect(reasonLanguage(["Fits the project", "The stack matches"])).toBe("en");
    expect(reasonLanguage(["Convient au projet", "La stack correspond"])).toBe("fr");
  });

  it("formats an escaped Markdown table", () => {
    expect(
      formatBenchmarkTable([
        {
          model: "vendor/model",
          valid: "yes",
          overlap: "40%",
          reasons: "en",
          latency: "120 ms",
          tokens: "10 / 5",
          cost: "$0.00",
          compose: "not run",
        },
      ]),
    ).toContain("| vendor/model | yes | 40% | en | 120 ms | 10 / 5 | $0.00 | not run |");
    expect(formatBenchmarkTable([{ model: "a|b" }])).toContain("a\\|b");
  });
});
