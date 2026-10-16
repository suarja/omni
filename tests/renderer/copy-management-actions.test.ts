import { expect, test } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import type { ManagedSkillUse, SkillLocationKey, SourceSkillRef } from "../../src/domain/skill-reconciliation/types";
import { buildCopyManagementReview } from "../../src/renderer/canvas/changes/copy-management-actions";

const location: SkillLocationKey = {
  projectId: "project-one",
  harnessId: "claude-code",
  folderPath: ".claude/skills/review",
};
const source: SourceSkillRef = { sourceId: "personal", packageId: "pstack", artifactPath: "skills/review" };
const managedUse: ManagedSkillUse = {
  skillId: "d4c8d2a7-11c1-4c71-9d13-3b06a4a37e81",
  bindingId: "binding-one",
  location,
  source,
  baseRevisionId: "d3477a13-4514-4de2-b9c9-f567fbb7e511",
};
const binding: Binding = {
  bindingId: managedUse.bindingId,
  sourceId: source.sourceId,
  packageId: source.packageId,
  artifactPath: `${source.artifactPath}/SKILL.md`,
  kind: "skill",
  projectId: location.projectId,
  harnessId: location.harnessId,
  boundHash: "a".repeat(64),
  createdAt: "2026-10-10T10:00:00.000Z",
};
const skillId = managedUse.skillId;

function input(action: "keep" | "link" | "canonical" | "capture" | "detach", managed = false) {
  return {
    action,
    skillId,
    location,
    readable: true,
    usesStatus: "ready" as const,
    ...(managed ? { locationUse: managedUse, binding } : {}),
  };
}

test("an unbound keep completes locally without inventing an operation receipt", () => {
  expect(buildCopyManagementReview(input("keep"))).toEqual({ kind: "local-no-write" });
});

test("every operation submits only the exact selected location", () => {
  const cases = [
    ["link", { source }, "link-canonical"],
    ["canonical", {}, "use-canonical"],
    [
      "capture",
      { destination: { sourceId: "personal", packageId: "pstack" }, skillKey: "review-copy" },
      "keep-variant",
    ],
    ["detach", {}, "detach-managed"],
  ] as const;

  for (const [action, options, choice] of cases) {
    const managed = action !== "link";
    const review = buildCopyManagementReview({ ...input(action, managed), ...options });
    expect(review.kind, action).toBe("operation");
    if (review.kind === "operation") {
      expect(review.intent).toMatchObject({ kind: "reconcile", request: { choice, locations: [location] } });
      expect(review.intent.kind === "reconcile" && review.intent.request.locations).toHaveLength(1);
    }
  }
});

test("a conflicting logical-skill use blocks management changes instead of appearing unbound", () => {
  const conflictingUse = { ...managedUse, skillId: "223e4567-e89b-42d3-a456-426614174000" };
  expect(
    buildCopyManagementReview({
      ...input("link"),
      locationUse: conflictingUse,
      source,
    }),
  ).toEqual({ kind: "unavailable", reason: "This location is managed under a different logical skill." });
  expect(buildCopyManagementReview({ ...input("keep"), locationUse: conflictingUse })).toEqual({
    kind: "unavailable",
    reason: "This location is managed under a different logical skill.",
  });
});

test("loading relationship evidence and an unreadable target cannot authorize a write", () => {
  expect(buildCopyManagementReview({ ...input("link"), usesStatus: "loading", source })).toMatchObject({
    kind: "unavailable",
  });
  expect(buildCopyManagementReview({ ...input("link"), readable: false, source })).toMatchObject({
    kind: "unavailable",
  });
});

test("managed replacement and detachment require a matching recorded Binding", () => {
  expect(buildCopyManagementReview({ ...input("canonical", true), binding: undefined })).toMatchObject({
    kind: "unavailable",
  });
  expect(
    buildCopyManagementReview({ ...input("detach", true), binding: { ...binding, harnessId: "codex" } }),
  ).toMatchObject({
    kind: "unavailable",
  });
});

test("capture requires a safe explicit destination and key", () => {
  expect(buildCopyManagementReview({ ...input("capture"), destination: undefined, skillKey: undefined })).toMatchObject(
    {
      kind: "unavailable",
    },
  );
  expect(
    buildCopyManagementReview({
      ...input("capture"),
      destination: { sourceId: "personal", packageId: "pstack" },
      skillKey: "../escape",
    }),
  ).toMatchObject({ kind: "unavailable" });
});
