import { expect, test } from "vitest";

import { aggregateSkillAttention, deriveSkillAttention } from "../../src/domain/skill-reconciliation/attention";
import type { SkillCopyLocationRead } from "../../src/domain/skill-reconciliation/types";

function locationRead(harnessId: "codex" | "claude-code", hash: string, unavailable = false): SkillCopyLocationRead {
  return {
    location: {
      projectId: "project-one",
      harnessId,
      folderPath: `${harnessId === "codex" ? ".agents" : ".claude"}/skills/review`,
    },
    read: unavailable
      ? { status: "unavailable", reason: "missing" }
      : {
          status: "complete",
          revision: {
            algorithm: "omni-tree-v1",
            hash,
            files: [{ path: "SKILL.md", hash, byteLength: 5 }],
          },
        },
  };
}

test("one complete unmanaged location stays visually quiet", () => {
  expect(deriveSkillAttention([locationRead("codex", "a".repeat(64))])).toEqual({ state: "quiet", reasons: [] });
});

test("complete unequal copies derive difference attention", () => {
  expect(
    deriveSkillAttention([locationRead("codex", "a".repeat(64)), locationRead("claude-code", "b".repeat(64))]),
  ).toEqual({ state: "copy-difference", reasons: ["copy-difference"] });
});

test("an incomplete required location prevents an equality claim", () => {
  expect(deriveSkillAttention([locationRead("codex", "a".repeat(64)), locationRead("claude-code", "", true)])).toEqual({
    state: "unavailable",
    reasons: ["unavailable"],
  });
});

test("ancestor attention retains mixed child reasons with difference precedence", () => {
  expect(
    aggregateSkillAttention([
      { state: "copy-difference", reasons: ["copy-difference"] },
      { state: "unavailable", reasons: ["unavailable"] },
      { state: "quiet", reasons: [] },
    ]),
  ).toEqual({ state: "copy-difference", reasons: ["copy-difference", "unavailable"] });
});
