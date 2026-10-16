import { expect, test } from "vitest";

import { correlateSkillCopies } from "../../src/domain/skill-reconciliation/correlation";
import type {
  SkillCopyLocationRead,
  SkillMember,
  SkillRevision,
  SkillTreeRead,
} from "../../src/domain/skill-reconciliation/types";

const complete = (digest: string): SkillRevision => ({
  algorithm: "omni-tree-v1",
  hash: digest.repeat(64),
  files: [
    { path: "SKILL.md", hash: "f".repeat(64), byteLength: 1 },
    { path: "references/support.md", hash: digest.repeat(64), byteLength: 1 },
  ],
});

function member(
  input: Readonly<{
    path: string;
    harness: "codex" | "claude-code";
    digest?: string;
    locator?: string;
    skillKey?: string;
  }>,
): SkillMember {
  const { path, harness, digest = "a", locator, skillKey } = input;
  return {
    location: { projectId: "p1", harnessId: harness, folderPath: path },
    ref: {
      kind: "artifact",
      entry: { kind: "project", id: "p1" },
      artifactId: `${harness}-${path.split("/").at(-1)}`,
    },
    read: { status: "complete", revision: complete(digest) },
    ...(locator && skillKey ? { declaration: { locator, skillKey } } : {}),
  };
}

function correlate(
  members: readonly SkillMember[],
  records: Parameters<typeof correlateSkillCopies>[0]["records"] = [],
  locationReads: readonly SkillCopyLocationRead[] = [],
) {
  let allocated = 0;
  return correlateSkillCopies({
    projectId: "p1",
    members,
    records,
    locationReads,
    allocateId: () => `skill-${++allocated}`,
  });
}

function locationRead(path: string, harness: "codex" | "claude-code", read: SkillTreeRead): SkillCopyLocationRead {
  return {
    location: { projectId: "p1", harnessId: harness, folderPath: path },
    read,
  };
}

test("equivalent local copies share a presentation without becoming managed", () => {
  const result = correlate([
    member({ path: ".agents/skills/design-bank", harness: "codex" }),
    member({ path: ".claude/skills/design-bank", harness: "claude-code" }),
  ]);

  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]?.members).toHaveLength(2);
  expect(result.groups[0]?.state).toBe("matching-copies");
  expect(result.records[0]?.evidence).toBe("observed-equivalence");
  expect(result.records[0]).not.toHaveProperty("source");
  expect(result.records[0]).not.toHaveProperty("uses");
  expect(result.records[0]).not.toHaveProperty("bindings");
});

test("declared keys group copies while different skills from one source stay separate", () => {
  const result = correlate([
    member({ path: ".agents/skills/convex", harness: "codex", locator: "Org/Repo", skillKey: "convex" }),
    member({ path: ".claude/skills/convex", harness: "claude-code", locator: "org/repo", skillKey: "convex" }),
    member({ path: ".agents/skills/convex-app", harness: "codex", locator: "org/repo", skillKey: "convex-app" }),
    member({ path: ".claude/skills/convex-app", harness: "claude-code", locator: "org/repo", skillKey: "convex-app" }),
  ]);

  expect(result.groups).toHaveLength(2);
  expect(result.groups.map((group) => group.members.length)).toEqual([2, 2]);
  expect(new Set(result.groups.map((group) => group.skillId)).size).toBe(2);
  expect(result.records.every((record) => record.evidence === "declared")).toBe(true);
  expect(result.records.every((record) => !("source" in record))).toBe(true);
});

test("first observed unequal declared copies stay one logical skill", () => {
  const result = correlate([
    member({ path: ".agents/skills/convex", harness: "codex", digest: "a", locator: "org/repo", skillKey: "convex" }),
    member({
      path: ".claude/skills/convex",
      harness: "claude-code",
      digest: "b",
      locator: "org/repo",
      skillKey: "convex",
    }),
  ]);

  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]?.members).toHaveLength(2);
  expect(result.groups[0]?.state).toBe("copy-difference");
  expect(result.records[0]?.evidence).toBe("declared");
  expect(result.records[0]?.reference).toBeUndefined();
});

test("unrelated equal-name origins stay distinct and produce a candidate", () => {
  const result = correlate([
    member({ path: ".agents/skills/design-bank", harness: "codex", locator: "one/repo", skillKey: "design-bank" }),
    member({
      path: ".claude/skills/design-bank",
      harness: "claude-code",
      locator: "two/repo",
      skillKey: "design-bank",
    }),
  ]);

  expect(result.groups).toHaveLength(2);
  expect(result.groups.map((group) => group.members.length)).toEqual([1, 1]);
  expect(result.candidates).toContainEqual({
    locations: result.groups
      .flatMap((group) => group.members)
      .map((item) => item.location)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    reason: "conflicting-lineage",
  });
});

test("a persisted equivalent membership retains its ID when a copy changes", () => {
  const first = correlate([
    member({ path: ".agents/skills/design-bank", harness: "codex" }),
    member({ path: ".claude/skills/design-bank", harness: "claude-code" }),
  ]);
  const changed = member({ path: ".claude/skills/design-bank", harness: "claude-code", digest: "b" });
  const next = correlate([member({ path: ".agents/skills/design-bank", harness: "codex" }), changed], first.records);

  expect(next.groups).toHaveLength(1);
  expect(next.groups[0]?.skillId).toBe(first.groups[0]?.skillId);
  expect(next.groups[0]?.state).toBe("copy-difference");
});

test("support edits, missing folders, and reappearance retain exact locations and the saved reference", () => {
  const codex = member({ path: ".agents/skills/design-bank", harness: "codex" });
  const claude = member({ path: ".claude/skills/design-bank", harness: "claude-code" });
  const first = correlate([codex, claude]);
  const savedReference = first.records[0]?.reference;
  const id = first.groups[0]?.skillId;
  const changedClaude = member({ path: ".claude/skills/design-bank", harness: "claude-code", digest: "b" });
  const changed = correlate([codex, changedClaude], first.records, [
    locationRead(codex.location.folderPath, "codex", codex.read),
    locationRead(changedClaude.location.folderPath, "claude-code", changedClaude.read),
  ]);

  expect(changed.groups[0]?.state).toBe("copy-difference");
  expect(changed.groups[0]?.locations).toHaveLength(2);
  expect(changed.groups[0]?.skillId).toBe(id);
  expect(changed.records[0]?.reference).toEqual(savedReference);

  const missing = correlate([codex], changed.records, [
    locationRead(codex.location.folderPath, "codex", codex.read),
    locationRead(changedClaude.location.folderPath, "claude-code", { status: "unavailable", reason: "missing" }),
  ]);
  expect(missing.groups[0]?.state).toBe("unavailable");
  expect(missing.groups[0]?.members).toHaveLength(1);
  expect(missing.groups[0]?.locations).toHaveLength(2);
  expect(
    missing.groups[0]?.locations.find(
      (locationRead) => locationRead.location.folderPath === changedClaude.location.folderPath,
    ),
  ).toEqual({ location: changedClaude.location, read: { status: "unavailable", reason: "missing" } });
  expect(missing.groups[0]?.skillId).toBe(id);
  expect(missing.records[0]?.reference).toEqual(savedReference);

  const restored = correlate([codex, claude], missing.records, [
    locationRead(codex.location.folderPath, "codex", codex.read),
    locationRead(claude.location.folderPath, "claude-code", claude.read),
  ]);
  expect(restored.groups[0]?.state).toBe("matching-copies");
  expect(restored.groups[0]?.skillId).toBe(id);
  expect(restored.records[0]?.reference).toEqual(savedReference);
});

test("a matching hash alone does not merge unrelated folder keys", () => {
  const result = correlate([
    member({ path: ".agents/skills/first", harness: "codex" }),
    member({ path: ".claude/skills/second", harness: "claude-code" }),
  ]);

  expect(result.groups).toHaveLength(2);
  expect(result.candidates).toContainEqual({
    locations: result.groups
      .flatMap((group) => group.members)
      .map((item) => item.location)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    reason: "same-content",
  });
});
