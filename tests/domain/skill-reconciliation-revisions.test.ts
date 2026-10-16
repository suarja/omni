import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { createSkillRevision, revisionsEqual } from "../../src/domain/skill-reconciliation/revisions";

test("the complete revision uses the stable path and file-hash manifest format", () => {
  const result = createSkillRevision(
    [
      { path: "resources/data.bin", hash: "b".repeat(64), byteLength: 5 },
      { path: "SKILL.md", hash: "a".repeat(64), byteLength: 3 },
    ],
    (manifest) => createHash("sha256").update(manifest, "utf8").digest("hex"),
  );

  expect(result).toEqual({
    algorithm: "omni-tree-v1",
    hash: "714fa5ec76f5b7445e7b6f24aeb12ee518a15176212c745c6aaad78b110f86bf",
    files: [
      { path: "resources/data.bin", hash: "b".repeat(64), byteLength: 5 },
      { path: "SKILL.md", hash: "a".repeat(64), byteLength: 3 },
    ],
  });
  expect(revisionsEqual(result, { ...result, algorithm: "vercel-lock-v1" } as unknown as typeof result)).toBe(false);
});
