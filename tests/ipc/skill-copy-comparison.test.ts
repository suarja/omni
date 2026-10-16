import { expect, test } from "vitest";

import {
  parseSkillCopyComparisonRequest,
  parseSkillCopyComparisonResponse,
} from "../../src/shared/skill-copy-comparison-ipc";

const a = { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/review" };
const b = { projectId: "project-one", harnessId: "claude-code", folderPath: ".claude/skills/review" };
const skillId = "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18";
const request = { projectId: "project-one", grantHandle: "grant-one", skillId, a, b };

test("accepts only a project-bound pair and one safe relative file path", () => {
  expect(parseSkillCopyComparisonRequest(request)).toEqual(request);
  expect(parseSkillCopyComparisonRequest({ ...request, filePath: "references/guide.md" })).toMatchObject({
    filePath: "references/guide.md",
  });
  expect(() => parseSkillCopyComparisonRequest({ ...request, extra: true })).toThrow(/unexpected field/i);
  expect(() => parseSkillCopyComparisonRequest({ ...request, sourcePath: "/tmp/source" })).toThrow(/unexpected field/i);
  expect(() => parseSkillCopyComparisonRequest({ ...request, base: "abc" })).toThrow(/unexpected field/i);
  expect(() => parseSkillCopyComparisonRequest({ ...request, a: { ...a, projectId: "another-project" } })).toThrow(
    /project/i,
  );
  expect(() => parseSkillCopyComparisonRequest({ ...request, b: a })).toThrow(/distinct/i);
  expect(() => parseSkillCopyComparisonRequest({ ...request, filePath: "../secret" })).toThrow(/relative path/i);
  expect(() => parseSkillCopyComparisonRequest({ ...request, filePath: "/etc/passwd" })).toThrow(/relative path/i);
});

const response = {
  status: "ready",
  projectId: "project-one",
  skillId,
  a: {
    location: a,
    read: {
      status: "complete",
      revision: {
        algorithm: "omni-tree-v1",
        hash: "a".repeat(64),
        files: [{ path: "SKILL.md", hash: "b".repeat(64), byteLength: 4 }],
      },
    },
  },
  b: {
    location: b,
    read: {
      status: "complete",
      revision: {
        algorithm: "omni-tree-v1",
        hash: "c".repeat(64),
        files: [{ path: "SKILL.md", hash: "d".repeat(64), byteLength: 4 }],
      },
    },
  },
  files: [
    {
      path: "SKILL.md",
      change: "change",
      left: { hash: "b".repeat(64), byteLength: 4 },
      right: { hash: "d".repeat(64), byteLength: 4 },
    },
  ],
  selectedPath: "SKILL.md",
  presentation: { presentation: "text", diff: "--- A\n+++ B\n", truncated: false },
  evidence: { source: "unknown", base: "unknown", relationship: "observed-equivalence" },
};

test("accepts a bounded response without transferring file bytes or claiming source authority", () => {
  const parsed = parseSkillCopyComparisonResponse(response);
  expect(parsed).toEqual(response);
  expect(JSON.stringify(parsed)).toMatch(/hash|revision/);
  expect(JSON.stringify(parsed)).not.toMatch(/fileBytes|sourcePath|basePath/i);
  expect(() => parseSkillCopyComparisonResponse({ ...response, fileBytes: "text" })).toThrow(/unexpected field/i);
  expect(() =>
    parseSkillCopyComparisonResponse({
      ...response,
      files: [{ ...response.files[0], left: { ...response.files[0].left, hash: "invalid" } }],
    }),
  ).toThrow(/invalid/i);
  expect(() =>
    parseSkillCopyComparisonResponse({ ...response, evidence: { ...response.evidence, source: "/tmp/source" } }),
  ).toThrow(/evidence/i);
  expect(() =>
    parseSkillCopyComparisonResponse({
      ...response,
      presentation: { ...response.presentation, diff: "x".repeat(64 * 1024 + 1) },
    }),
  ).toThrow(/diff/i);
  expect(() => parseSkillCopyComparisonResponse({ ...response, selectedPath: "missing.md" })).toThrow(/selected/i);
  expect(() =>
    parseSkillCopyComparisonResponse({
      ...response,
      files: [{ ...response.files[0], change: "add" }],
    }),
  ).toThrow(/file sides/i);
});
