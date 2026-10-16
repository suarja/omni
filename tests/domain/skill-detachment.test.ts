import { describe, expect, it } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import { fingerprintSkillEffects } from "../../src/domain/skill-management-intent";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
} from "../../src/domain/skill-reconciliation/types";
import { planSkillDetachment } from "../../src/domain/skill-reconciliation/detachment";
import type { SkillDetachmentRequest } from "../../src/shared/skill-detachment-request";
import type { SkillDirectoryEnvelope } from "../../src/shared/skill-directory-envelope";

const location: SkillLocationKey = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" };
const source: SourceSkillRef = { sourceId: "source-tools", packageId: "tools", artifactPath: "skills/demo" };
const skillId = "123e4567-e89b-42d3-a456-426614174000";
const baseRevisionId = "123e4567-e89b-42d3-a456-426614174001";
const request: SkillDetachmentRequest = { choice: "detach-managed", skillId, locations: [location] };
const baseRevision: SkillRevision = {
  algorithm: "omni-tree-v1",
  hash: "a".repeat(64),
  files: [{ path: "SKILL.md", hash: "b".repeat(64), byteLength: 12 }],
};
const localRevision: SkillRevision = {
  ...baseRevision,
  hash: "c".repeat(64),
  files: [{ path: "SKILL.md", hash: "d".repeat(64), byteLength: 18 }],
};
const record: LogicalSkillRecord = { skillId, label: "demo", evidence: "individual", locations: [location] };
const use: ManagedSkillUse = { skillId, bindingId: "binding-demo", location, source, baseRevisionId };
const binding: Binding = {
  bindingId: use.bindingId,
  sourceId: source.sourceId,
  packageId: source.packageId,
  artifactPath: `${source.artifactPath}/SKILL.md`,
  kind: "skill",
  projectId: location.projectId,
  harnessId: location.harnessId,
  boundHash: baseRevision.hash,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const envelope: SkillDirectoryEnvelope = [
  { path: ".", kind: "directory", identity: "dev:1:10" },
  { path: "SKILL.md", kind: "file", identity: "dev:1:11" },
  { path: ".git", kind: "directory", identity: "dev:1:12" },
];

function plan(overrides: Record<string, unknown> = {}) {
  return planSkillDetachment({
    request,
    record,
    storeRevision: 4,
    local: { location, rootIdentity: "e".repeat(64), revision: localRevision, envelope },
    use,
    binding,
    base: { baseRevisionId, revision: baseRevision },
    bindings: [binding],
    uses: [use],
    intentId: "intent-d4",
    ...overrides,
  });
}

describe("planSkillDetachment", () => {
  it("removes only the selected tracking records while retaining edited files and base evidence", () => {
    const result = plan();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.files).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.bindingEffects).toEqual([{ bindingId: binding.bindingId, before: binding }]);
    expect(result.metadataEffects).toEqual([{ skillId, location, before: use }]);
    expect(result.evidence.base).toEqual({ baseRevisionId, revision: baseRevision });
    expect(result.evidence.record).toEqual(record);
    expect(result.evidence.local.revision).toEqual(localRevision);
  });

  it("requires a fresh management decision when the selected use is already absent", () => {
    expect(plan({ use: undefined, binding: undefined, uses: [], bindings: [] })).toMatchObject({
      status: "needs-input",
    });
  });

  it("blocks a legacy Binding without a managed use and any competing claim on the target", () => {
    expect(plan({ use: undefined, uses: [] })).toMatchObject({ status: "blocked" });
    expect(
      plan({
        bindings: [binding, { ...binding, bindingId: "binding-other", sourceId: "source-other" }],
      }),
    ).toMatchObject({ status: "blocked" });
  });

  it("blocks mismatched source, binding, membership, and corrupt base evidence", () => {
    expect(plan({ use: { ...use, source: { ...source, packageId: "other" } } })).toMatchObject({ status: "blocked" });
    expect(plan({ binding: { ...binding, artifactPath: "skills/other/SKILL.md" } })).toMatchObject({
      status: "blocked",
    });
    expect(plan({ record: { ...record, locations: [] } })).toMatchObject({ status: "blocked" });
    expect(plan({ base: undefined })).toMatchObject({ status: "needs-input" });
  });

  it("fingerprints the selected location, local tree, envelope, relationships, and saved base", () => {
    const result = plan();
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const intent = { kind: "reconcile" as const, request };
    const original = fingerprintSkillEffects(intent, result.fingerprint);
    const changed = fingerprintSkillEffects(intent, {
      ...result.fingerprint,
      detachmentEvidence: {
        ...result.evidence,
        local: { ...result.evidence.local, rootIdentity: "f".repeat(64) },
      },
    });
    expect(changed).not.toBe(original);
  });
});
