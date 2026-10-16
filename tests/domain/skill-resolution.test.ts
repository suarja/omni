import { describe, expect, it } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import { planManagedSkillResolution } from "../../src/domain/skill-reconciliation/resolution";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
} from "../../src/domain/skill-reconciliation/types";
import type { SkillManagedResolutionRequest } from "../../src/shared/skill-reconciliation-request";

const skillId = "123e4567-e89b-42d3-a456-426614174000";
const baseId = "123e4567-e89b-42d3-a456-426614174001";
const location: SkillLocationKey = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" };
const source: SourceSkillRef = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" };
const request = (choice: SkillManagedResolutionRequest["choice"]): SkillManagedResolutionRequest => ({
  choice,
  skillId,
  locations: [location],
});
const revision = (files: SkillRevision["files"]): SkillRevision => ({
  algorithm: "omni-tree-v1",
  hash: files
    .map(({ path, hash }) => `${path}:${hash}`)
    .join("\n")
    .length.toString(16)
    .padStart(64, "0"),
  files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
});
const file = (path: string, hash: string, byteLength = 4) => ({ path, hash: hash.repeat(64).slice(0, 64), byteLength });
const baseRevision = revision([file("SKILL.md", "a"), file("notes.md", "b")]);
const localRevision = revision([file("SKILL.md", "a"), file("local-only.md", "c")]);
const sourceRevision = revision([file("SKILL.md", "d"), file("notes.md", "b"), file("support/data.bin", "e", 3)]);
const record: LogicalSkillRecord = { skillId, label: "demo", evidence: "individual", locations: [location] };
const use: ManagedSkillUse = { skillId, bindingId: "binding-a", location, source, baseRevisionId: baseId };
const binding: Binding = {
  bindingId: "binding-a",
  sourceId: source.sourceId,
  packageId: source.packageId,
  artifactPath: `${source.artifactPath}/SKILL.md`,
  kind: "skill",
  projectId: location.projectId,
  harnessId: location.harnessId,
  boundHash: baseRevision.hash,
  ownedHash: baseRevision.hash,
  createdAt: "2026-10-01T00:00:00.000Z",
};

function plan(choice: SkillManagedResolutionRequest["choice"], overrides: Record<string, unknown> = {}) {
  return planManagedSkillResolution({
    request: request(choice),
    record,
    storeRevision: 3,
    use,
    binding,
    local: { rootIdentity: "f".repeat(64), revision: localRevision },
    base: { baseRevisionId: baseId, revision: baseRevision },
    sourceTree: { ref: source, rootIdentity: "0".repeat(64), revision: sourceRevision },
    intentId: "intent-a",
    ...overrides,
  } as Parameters<typeof planManagedSkillResolution>[0]);
}

describe("planManagedSkillResolution", () => {
  it("records Keep local without file or metadata changes and retains the verified base", () => {
    const result = plan("keep-local");
    expect(result).toMatchObject({
      status: "ready",
      choice: "keep-local",
      noOp: false,
      files: [],
      metadataEffects: [],
      bindingEffects: [],
    });
    if (result.status !== "ready") return;
    expect(result.baseReferences).toEqual([{ baseRevisionId: baseId, revision: baseRevision }]);
    expect(result.evidence.local.revision).toEqual(localRevision);
    expect(result.evidence.base.revision).toEqual(baseRevision);
  });

  it("plans byte-complete add/change/delete effects for the selected folder only", () => {
    const result = plan("use-canonical");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.files.map(({ relativePath, change }) => [relativePath, change])).toEqual([
      [".agents/skills/demo/local-only.md", "delete"],
      [".agents/skills/demo/notes.md", "add"],
      [".agents/skills/demo/SKILL.md", "change"],
      [".agents/skills/demo/support/data.bin", "add"],
    ]);
    expect(result.metadataEffects).toHaveLength(1);
    expect(result.bindingEffects[0]?.after).toMatchObject({
      bindingId: "binding-a",
      boundHash: sourceRevision.hash,
      ownedHash: sourceRevision.hash,
    });
    expect(result.metadataEffects[0]?.after).toMatchObject({ bindingId: "binding-a", source, location });
  });

  it("refreshes only base metadata when local already equals a changed source", () => {
    const result = plan("use-canonical", {
      local: { rootIdentity: "f".repeat(64), revision: sourceRevision },
      sourceTree: { ref: source, rootIdentity: "0".repeat(64), revision: sourceRevision },
    });
    expect(result).toMatchObject({ status: "ready", noOp: false, files: [] });
    if (result.status !== "ready") return;
    expect(result.metadataEffects[0]?.after?.baseRevisionId).not.toBe(baseId);
    expect(result.baseReferences).toHaveLength(2);
  });

  it("returns a true no-op only when source, local, base and binding metadata agree", () => {
    const result = plan("use-canonical", {
      local: { rootIdentity: "f".repeat(64), revision: baseRevision },
      sourceTree: { ref: source, rootIdentity: "0".repeat(64), revision: baseRevision },
      binding: { ...binding, boundHash: baseRevision.hash, ownedHash: baseRevision.hash },
    });
    expect(result).toMatchObject({ status: "ready", noOp: true, files: [], metadataEffects: [] });
  });

  it("allows Keep local with unavailable source but withholds canonical replacement", () => {
    expect(plan("keep-local", { sourceTree: undefined })).toMatchObject({ status: "ready", choice: "keep-local" });
    expect(plan("use-canonical", { sourceTree: undefined })).toMatchObject({
      status: "needs-input",
      code: "source-unavailable",
    });
  });

  it("withholds effects when the base, selected membership or exact use is missing", () => {
    expect(plan("use-canonical", { base: undefined })).toMatchObject({
      status: "needs-input",
      code: "base-unavailable",
    });
    expect(plan("use-canonical", { record: { ...record, locations: [] } })).toMatchObject({
      status: "blocked",
      code: "location-not-in-skill",
    });
    expect(plan("use-canonical", { use: undefined })).toMatchObject({
      status: "blocked",
      code: "managed-use-unavailable",
    });
  });

  it("rejects mismatched approved source or Binding authority", () => {
    expect(
      plan("use-canonical", {
        sourceTree: {
          ref: { ...source, packageId: "packages/other" },
          rootIdentity: "0".repeat(64),
          revision: sourceRevision,
        },
      }),
    ).toMatchObject({ status: "blocked", code: "source-mismatch" });
    expect(plan("use-canonical", { binding: { ...binding, bindingId: "binding-other" } })).toMatchObject({
      status: "blocked",
      code: "use-binding-mismatch",
    });
  });
});
