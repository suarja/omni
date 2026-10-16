import { describe, expect, it } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
} from "../../src/domain/skill-reconciliation/types";
import type { SkillUnboundResolutionRequest } from "../../src/shared/skill-unbound-resolution-request";
import { planUnboundSkillResolution } from "../../src/domain/skill-reconciliation/unbound-resolution";

const source: SourceSkillRef = { sourceId: "source-tools", packageId: "tools", artifactPath: "skills/demo" };
const location: SkillLocationKey = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" };
const skillId = "123e4567-e89b-42d3-a456-426614174000";
const request: SkillUnboundResolutionRequest = { choice: "link-canonical", skillId, source, locations: [location] };
const digest = (letter: string): string => letter.repeat(64);
const revision = (path: string, hash: string): SkillRevision => ({
  algorithm: "omni-tree-v1",
  hash: digest(hash),
  files: [{ path, hash: digest(hash), byteLength: 4 }],
});
const record: LogicalSkillRecord = { skillId, label: "Demo", evidence: "individual", locations: [location] };
const roots = { source: digest("a"), local: digest("b") };

function plan(
  localRevision: SkillRevision,
  sourceRevision: SkillRevision,
  options: Readonly<{
    uses?: readonly ManagedSkillUse[];
    bindings?: readonly Binding[];
  }> = {},
) {
  return planUnboundSkillResolution({
    request,
    record,
    storeRevision: 4,
    source: { ref: source, rootIdentity: roots.source, revision: sourceRevision },
    local: { location, rootIdentity: roots.local, revision: localRevision },
    envelope: {
      source: [{ path: ".", kind: "directory", identity: "source-root" }],
      local: [{ path: ".", kind: "directory", identity: "local-root" }],
    },
    uses: options.uses ?? [],
    bindings: options.bindings ?? [],
    allocateId: (kind) =>
      kind === "step"
        ? "123e4567-e89b-42d3-a456-426614174010"
        : kind === "binding"
          ? "123e4567-e89b-42d3-a456-426614174011"
          : "123e4567-e89b-42d3-a456-426614174012",
    now: "2026-10-09T12:00:00.000Z",
  });
}

describe("unbound canonical resolution policy", () => {
  it("routes complete equality to metadata-only C adoption without inventing a base", () => {
    const tree = revision("SKILL.md", "a");
    expect(plan(tree, tree)).toMatchObject({
      status: "adopt-exact",
      request: { choice: "adopt-exact", skillId, source, locations: [location] },
    });
  });

  it("plans one exact canonical replacement and creates management only in the approved after state", () => {
    const result = plan(revision("local.md", "b"), revision("SKILL.md", "a"));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.evidence.priorManagement).toEqual({ use: "absent", binding: "absent", base: "unknown" });
    expect(
      result.files
        .map(({ relativePath, change }) => [relativePath, change])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      [".agents/skills/demo/local.md", "delete"],
      [".agents/skills/demo/SKILL.md", "add"],
    ]);
    expect(result.metadataEffects).toHaveLength(1);
    expect(result.metadataEffects[0]?.before).toBeUndefined();
    expect(result.bindingEffects).toHaveLength(1);
    expect(result.bindingEffects[0]?.before).toBeUndefined();
    expect(result.baseReferences).toHaveLength(1);
    expect(result.baseReferences[0]?.revision).toEqual(revision("SKILL.md", "a"));
  });

  it("blocks a target already claimed by an exact use or legacy Binding", () => {
    const claimedUse: ManagedSkillUse = {
      skillId,
      bindingId: "legacy-binding",
      location,
      source,
      baseRevisionId: "123e4567-e89b-42d3-a456-426614174002",
    };
    const legacyBinding: Binding = {
      bindingId: "legacy-binding",
      sourceId: source.sourceId,
      packageId: source.packageId,
      artifactPath: `${source.artifactPath}/SKILL.md`,
      kind: "skill",
      projectId: location.projectId,
      harnessId: location.harnessId,
      boundHash: digest("a"),
      ownedHash: digest("a"),
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    expect(plan(revision("local.md", "b"), revision("SKILL.md", "a"), { uses: [claimedUse] })).toMatchObject({
      status: "blocked",
    });
    expect(plan(revision("local.md", "b"), revision("SKILL.md", "a"), { bindings: [legacyBinding] })).toMatchObject({
      status: "blocked",
    });
  });

  it("blocks a different approved source already using the same logical skill", () => {
    const otherUse: ManagedSkillUse = {
      skillId,
      bindingId: "other-binding",
      location: { ...location, harnessId: "claude-code", folderPath: ".claude/skills/demo" },
      source: { ...source, sourceId: "source-other" },
      baseRevisionId: "123e4567-e89b-42d3-a456-426614174002",
    };
    expect(plan(revision("local.md", "b"), revision("SKILL.md", "a"), { uses: [otherUse] })).toMatchObject({
      status: "blocked",
    });
  });
});
