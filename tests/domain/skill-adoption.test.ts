import { describe, expect, it } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import { planSkillAdoption } from "../../src/domain/skill-reconciliation/adoption";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
} from "../../src/domain/skill-reconciliation/types";
import type { SkillAdoptionRequest } from "../../src/shared/skill-reconciliation-request";

const sourceId = "source-tools";
const packageId = "tools";
const artifactPath = "skills/demo";
const skillId = "123e4567-e89b-42d3-a456-426614174000";
const baseRevisionId = "123e4567-e89b-42d3-a456-426614174001";
const createdBaseId = "123e4567-e89b-42d3-a456-426614174002";
const source: SourceSkillRef = { sourceId, packageId, artifactPath };
const codex: SkillLocationKey = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" };
const claude: SkillLocationKey = {
  projectId: "project-a",
  harnessId: "claude-code",
  folderPath: ".claude/skills/demo",
};
const request: SkillAdoptionRequest = { choice: "adopt-exact", skillId, source, locations: [codex] };
const revision: SkillRevision = {
  algorithm: "omni-tree-v1",
  hash: "a".repeat(64),
  files: [
    { path: "SKILL.md", hash: "b".repeat(64), byteLength: 12 },
    { path: "assets/data.bin", hash: "c".repeat(64), byteLength: 7 },
  ],
};
const equalRevision = (overrides: Partial<SkillRevision> = {}): SkillRevision => ({ ...revision, ...overrides });
const record: LogicalSkillRecord = {
  skillId,
  label: "demo",
  evidence: "individual",
  locations: [codex, claude],
};

function binding(overrides: Partial<Binding> = {}): Binding {
  return {
    bindingId: "binding-legacy",
    sourceId,
    packageId,
    artifactPath: `${artifactPath}/SKILL.md`,
    kind: "skill",
    projectId: codex.projectId,
    harnessId: codex.harnessId,
    boundHash: "d".repeat(64),
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function use(overrides: Partial<ManagedSkillUse> = {}): ManagedSkillUse {
  return {
    skillId,
    bindingId: "binding-legacy",
    location: codex,
    source,
    baseRevisionId,
    ...overrides,
  };
}

function plan(args: Partial<Parameters<typeof planSkillAdoption>[0]> = {}) {
  return planSkillAdoption({
    request,
    record,
    sourceRevision: revision,
    locals: [{ location: codex, revision }],
    bindings: [],
    uses: [],
    baseRevisionId: createdBaseId,
    now: "2026-10-08T12:00:00.000Z",
    allocateBindingId: () => "123e4567-e89b-42d3-a456-426614174003",
    ...args,
  });
}

describe("planSkillAdoption", () => {
  it("manages only the explicitly selected equal copy and preserves an equal legacy binding", () => {
    const result = plan({ bindings: [binding()] });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.bindingEffects).toHaveLength(1);
    expect(result.metadataEffects).toHaveLength(1);
    expect(result.metadataEffects[0]?.location).toEqual(codex);
    expect(result.bindingEffects[0]?.before?.bindingId).toBe("binding-legacy");
    expect(result.bindingEffects[0]?.after).toMatchObject({
      bindingId: "binding-legacy",
      createdAt: "2026-10-01T00:00:00.000Z",
      boundHash: revision.hash,
      ownedHash: revision.hash,
    });
    expect(result.metadataEffects[0]?.after).toMatchObject({
      bindingId: "binding-legacy",
      source,
      baseRevisionId: createdBaseId,
    });
  });

  it("rejects a target with the same SKILL.md but different complete-tree support bytes", () => {
    const unequal = equalRevision({
      hash: "e".repeat(64),
      files: [revision.files[0]!, { path: "assets/data.bin", hash: "f".repeat(64), byteLength: 7 }],
    });

    expect(plan({ locals: [{ location: codex, revision: unequal }] })).toMatchObject({ status: "needs-input" });
  });

  it("blocks a different source claim in either the exact binding or logical skill uses", () => {
    const otherSource: SourceSkillRef = { ...source, sourceId: "source-other" };

    expect(plan({ bindings: [binding({ sourceId: "source-other" })] })).toMatchObject({ status: "blocked" });
    expect(plan({ uses: [use({ source: otherSource })] })).toMatchObject({ status: "blocked" });
  });

  it("returns a metadata no-op for an already verified exact use and binding", () => {
    const existing = binding({ boundHash: revision.hash, ownedHash: revision.hash });
    const currentUse = use({ baseRevisionId });
    const result = plan({ bindings: [existing], uses: [currentUse], baseRevisionId });

    expect(result).toMatchObject({ status: "ready", noOp: true });
    if (result.status !== "ready") return;
    expect(result.bindingEffects[0]?.before).toEqual(result.bindingEffects[0]?.after);
    expect(result.metadataEffects[0]?.before).toEqual(result.metadataEffects[0]?.after);
  });

  it("rejects selected locations outside the persisted logical record", () => {
    expect(
      plan({
        record: { ...record, locations: [codex] },
        request: { ...request, locations: [claude] },
        locals: [{ location: claude, revision }],
      }),
    ).toMatchObject({
      status: "blocked",
    });
  });
});
