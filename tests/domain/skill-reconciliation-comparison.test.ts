import { expect, test, vi } from "vitest";

import {
  chooseSkillCopyFile,
  compareSkillCopyFileBytes,
  unionSkillCopyFiles,
} from "../../src/domain/skill-reconciliation/comparison";
import type { SkillRevision } from "../../src/domain/skill-reconciliation/types";
import type { createUnifiedDiff } from "../../src/domain/unified-diff";

function revision(files: readonly Readonly<{ path: string; hash: string; byteLength: number }>[]): SkillRevision {
  return {
    algorithm: "omni-tree-v1",
    hash: "a".repeat(64),
    files: files.map((file) => ({ ...file })),
  };
}

test("unions complete trees by sorted relative path and keeps observational direction", () => {
  const files = unionSkillCopyFiles(
    revision([
      { path: "SKILL.md", hash: "a".repeat(64), byteLength: 9 },
      { path: "references/change.md", hash: "b".repeat(64), byteLength: 4 },
      { path: "references/delete.md", hash: "c".repeat(64), byteLength: 2 },
    ]),
    revision([
      { path: "SKILL.md", hash: "a".repeat(64), byteLength: 9 },
      { path: "references/add.md", hash: "d".repeat(64), byteLength: 3 },
      { path: "references/change.md", hash: "e".repeat(64), byteLength: 5 },
    ]),
  );

  expect(files).toEqual([
    {
      path: "SKILL.md",
      change: "unchanged",
      left: { hash: "a".repeat(64), byteLength: 9 },
      right: { hash: "a".repeat(64), byteLength: 9 },
    },
    { path: "references/add.md", change: "add", right: { hash: "d".repeat(64), byteLength: 3 } },
    {
      path: "references/change.md",
      change: "change",
      left: { hash: "b".repeat(64), byteLength: 4 },
      right: { hash: "e".repeat(64), byteLength: 5 },
    },
    { path: "references/delete.md", change: "delete", left: { hash: "c".repeat(64), byteLength: 2 } },
  ]);
});

test("selects the first changed file, then SKILL.md, then the first path", () => {
  const files = unionSkillCopyFiles(
    revision([{ path: "SKILL.md", hash: "a".repeat(64), byteLength: 1 }]),
    revision([
      { path: "SKILL.md", hash: "a".repeat(64), byteLength: 1 },
      { path: "references/new.md", hash: "b".repeat(64), byteLength: 1 },
    ]),
  );
  expect(chooseSkillCopyFile(files)).toBe("references/new.md");
  expect(chooseSkillCopyFile([{ path: "SKILL.md", change: "unchanged" }])).toBe("SKILL.md");
  expect(chooseSkillCopyFile([{ path: "references/only.md", change: "unchanged" }])).toBe("references/only.md");
  expect(chooseSkillCopyFile([])).toBeUndefined();
  expect(chooseSkillCopyFile(files, "SKILL.md")).toBe("SKILL.md");
  expect(chooseSkillCopyFile(files, "missing.md")).toBeUndefined();
});

test("summarizes binary and invalid UTF-8 changes without exposing text", () => {
  const file = { path: "asset.bin", change: "change" as const };
  expect(compareSkillCopyFileBytes(file, Buffer.from([0, 1]), Buffer.from([0, 2])).presentation).toBe("binary");
  expect(compareSkillCopyFileBytes(file, Buffer.from([0xff]), Buffer.from([0xfe])).presentation).toBe("binary");
});

test("summarizes large and complex text before invoking the LCS renderer", () => {
  const render = vi.fn<typeof createUnifiedDiff>(() => ({ kind: "unified", text: "unexpected", truncated: false }));
  const file = { path: "large.md", change: "change" as const };
  const large = compareSkillCopyFileBytes(file, Buffer.from("a".repeat(64 * 1024 + 1)), Buffer.from("b"), render);
  expect(large.presentation).toBe("too-large");
  expect(render).not.toHaveBeenCalled();

  const thousandLines = Array.from({ length: 1000 }, (_, index) => `left ${index}`).join("\n");
  const complex = compareSkillCopyFileBytes(
    file,
    Buffer.from(thousandLines),
    Buffer.from("right\n".repeat(1000)),
    render,
  );
  expect(complex.presentation).toBe("too-large");
  expect(render).not.toHaveBeenCalled();
});

test("reports byte-only newline differences while keeping the tree difference visible", () => {
  const result = compareSkillCopyFileBytes(
    { path: "SKILL.md", change: "change" },
    Buffer.from("same\r\n"),
    Buffer.from("same\n"),
  );
  expect(result).toMatchObject({ presentation: "text", byteDifferenceNotice: true, truncated: false });
});

test("does not compare revisions from different hash namespaces", () => {
  expect(() =>
    unionSkillCopyFiles(revision([]), {
      ...revision([]),
      algorithm: "vercel-lock-v1",
    } as unknown as SkillRevision),
  ).toThrow(/algorithm/i);
});
