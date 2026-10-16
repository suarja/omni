import { describe, expect, it, vi } from "vitest";

import { createUnifiedDiff } from "../../src/domain/unified-diff";

describe("unified diff", () => {
  it("renders a byte-bounded UTF-8 diff in a sandboxed renderer", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      const result = createUnifiedDiff("mine", "source", "café\n", "café changed 🙂\n", 40);
      expect(result.text).toContain("--- mine\n+++ source\n");
      expect(result.truncated).toBe(true);
      expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(40);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders line additions and removals with file labels", () => {
    expect(createUnifiedDiff("project.txt", "marketplace.txt", "one\ntwo\n", "one\nthree\n")).toEqual({
      kind: "unified",
      text: "--- project.txt\n+++ marketplace.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
      truncated: false,
    });
  });

  it("splits distant changes into hunks with three lines of context", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const after = before.replace("line 5\n", "line five\n").replace("line 30\n", "line thirty\n");
    const { text } = createUnifiedDiff("a", "a", before, after);
    expect(text).toBe(
      [
        "--- a",
        "+++ a",
        "@@ -2,7 +2,7 @@",
        " line 2",
        " line 3",
        " line 4",
        "-line 5",
        "+line five",
        " line 6",
        " line 7",
        " line 8",
        "@@ -27,7 +27,7 @@",
        " line 27",
        " line 28",
        " line 29",
        "-line 30",
        "+line thirty",
        " line 31",
        " line 32",
        " line 33",
        "",
      ].join("\n"),
    );
    expect(createUnifiedDiff("a", "a", before, before).text).toBe("--- a\n+++ a\n");
  });

  it("marks binary content and truncates by byte budget", () => {
    expect(createUnifiedDiff("mine", "theirs", Buffer.from([0, 1]), Buffer.from([0, 2]))).toEqual({
      kind: "unified",
      text: "binary file differs",
      truncated: false,
    });
    const result = createUnifiedDiff("mine", "theirs", "a\n".repeat(200), "b\n".repeat(200), 64);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(64);
  });
});
