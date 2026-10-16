import { describe, expect, it } from "vitest";
import { parseDiffLines, pairDiffLines } from "../../src/renderer/canvas/changes/diff-lines";

describe("reviewed diff excerpts", () => {
  it("numbers current and proposed lines from actual hunk coordinates", () => {
    const parsed = parseDiffLines(
      "--- current\n+++ proposed\n@@ -8,2 +8,2 @@\n-old\n+<script>alert('unsafe')</script>\n kept\n",
    );
    expect(parsed.lines).toMatchObject([
      { kind: "hunk" },
      { kind: "remove", before: 8, text: "old" },
      { kind: "add", after: 8, text: "<script>alert('unsafe')</script>" },
      { kind: "context", before: 9, after: 9, text: "kept" },
    ]);
    expect(pairDiffLines(parsed.lines)).toMatchObject([
      { kind: "hunk" },
      { before: { text: "old" }, after: { text: "<script>alert('unsafe')</script>" } },
      { before: { text: "kept" }, after: { text: "kept" } },
    ]);
  });
  it("caps large excerpts and keeps binary summaries out of textual rows", () => {
    const parsed = parseDiffLines("@@ -0,0 +1,2000 @@\n" + "+line\n".repeat(2000));
    expect(parsed.truncated).toBe(true);
    expect(parsed.lines.length).toBeLessThanOrEqual(1200);
    expect(parseDiffLines("binary file differs")).toMatchObject({ lines: [], summary: "binary file differs" });
  });
});
