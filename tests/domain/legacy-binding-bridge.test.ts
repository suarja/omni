import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  planLegacyBindingBridge,
  matchesBindingSourceRepresentation,
  type LegacyBindingCopy,
} from "../../src/domain/skill-reconciliation/legacy-binding-bridge";
import type { SkillRelationshipsState } from "../../src/domain/skill-reconciliation/types";
import { parseManagedSkillUse } from "../../src/domain/skill-reconciliation/validation";
import { parseOperationReceipt } from "../../src/shared/operations-receipt-parsers";
import { parseEffectStep } from "../../src/shared/skill-management-effect-parser";

function copy(harnessId: "codex" | "claude-code", sourceId = "source-one"): LegacyBindingCopy {
  const source = { sourceId, packageId: "packages/tools", artifactPath: "skills/demo" };
  const location = {
    projectId: "project-one",
    harnessId,
    folderPath: `${harnessId === "codex" ? ".agents" : ".claude"}/skills/demo`,
  };
  return {
    source,
    location,
    baseRevisionId: randomUUID(),
    binding: {
      ...source,
      bindingId: `binding-${harnessId}`,
      projectId: location.projectId,
      harnessId,
      kind: "skill",
      boundHash: "0".repeat(64),
      ownedHash: "0".repeat(64),
      createdAt: "2026-10-11T00:00:00.000Z",
    },
  };
}

const empty = (): SkillRelationshipsState => ({ schemaVersion: 1, revision: 0, skills: [], uses: [] });

describe("legacy Binding metadata rules", () => {
  it("merges observed harness records by the exact source identity and preserves unrelated locations", () => {
    const codex = copy("codex"),
      claude = copy("claude-code");
    const codexRecord = {
      skillId: randomUUID(),
      label: "demo",
      evidence: "individual" as const,
      locations: [codex.location],
    };
    const otherLocation = { ...claude.location, folderPath: ".claude/skills/other" };
    const claudeRecord = {
      skillId: randomUUID(),
      label: "demo",
      evidence: "individual" as const,
      locations: [claude.location, otherLocation],
    };
    const plan = planLegacyBindingBridge(
      { ...empty(), skills: [codexRecord, claudeRecord] },
      [codex, claude],
      randomUUID,
    );
    expect(plan.uses.map(({ skillId }) => skillId)).toEqual([codexRecord.skillId, codexRecord.skillId]);
    expect(plan.records.find(({ skillId }) => skillId === claudeRecord.skillId)?.after?.locations).toEqual([
      otherLocation,
    ]);
    expect(plan.records.find(({ skillId }) => skillId === codexRecord.skillId)?.after?.locations).toEqual([
      codex.location,
      claude.location,
    ]);
  });

  it("does not merge equal skill names from distinct source identities", () => {
    const plan = planLegacyBindingBridge(empty(), [copy("codex"), copy("claude-code", "source-two")], randomUUID);
    expect(new Set(plan.uses.map(({ skillId }) => skillId)).size).toBe(2);
  });

  it("adds a harness use to the already managed source identity", () => {
    const codex = copy("codex"),
      claude = copy("claude-code");
    const skill = {
      skillId: randomUUID(),
      label: "demo",
      evidence: "individual" as const,
      locations: [codex.location],
    };
    const use = {
      skillId: skill.skillId,
      bindingId: codex.binding.bindingId,
      source: codex.source,
      location: codex.location,
      baseRevisionId: codex.baseRevisionId,
    };
    const plan = planLegacyBindingBridge({ ...empty(), skills: [skill], uses: [use] }, [claude], randomUUID);
    expect(plan.uses[0]?.skillId).toBe(skill.skillId);
    expect(plan.records[0]?.after?.locations).toEqual([codex.location, claude.location]);
  });

  it("validates the explicit unavailable-base marker strictly", () => {
    const legacy = copy("codex");
    const use = planLegacyBindingBridge(empty(), [{ ...legacy, baseUnavailable: true }], randomUUID).uses[0]!;
    expect(parseManagedSkillUse(use)).toEqual(use);
    expect(() => parseManagedSkillUse({ ...use, baseUnavailable: false })).toThrow("marker is invalid");
  });

  it("rejects bridge receipts with file effects, duplicate uses or inconsistent record identities", () => {
    const effect = planLegacyBindingBridge(empty(), [copy("codex")], randomUUID);
    const receipt = {
      operationId: randomUUID(),
      kind: "bridge-skill-uses",
      status: "applied",
      appliedAt: "2026-10-11T00:00:00.000Z",
      displayTarget: "Omni now tracks 1 copy",
      actions: [],
      git: { mode: "unavailable" },
      registered: null,
      legacyBridge: { phase: "applied", ...effect },
    };
    expect(parseOperationReceipt(receipt).legacyBridge?.uses).toEqual(effect.uses);
    expect(() => parseOperationReceipt({ ...receipt, files: [] })).toThrow("metadata-only");
    expect(() =>
      parseOperationReceipt({
        ...receipt,
        legacyBridge: { ...receipt.legacyBridge, uses: [...effect.uses, ...effect.uses] },
      }),
    ).toThrow("unique");
    expect(() =>
      parseOperationReceipt({
        ...receipt,
        legacyBridge: { ...receipt.legacyBridge, records: [{ ...effect.records[0], skillId: randomUUID() }] },
      }),
    ).toThrow("identity");
  });

  it("allows only exact use removals in a bridge restore step", () => {
    const use = planLegacyBindingBridge(empty(), [copy("codex")], randomUUID).uses[0]!;
    const step = {
      stepId: randomUUID(),
      scope: {
        targets: [{ projectId: use.location.projectId, harnessId: use.location.harnessId, bindingId: use.bindingId }],
      },
      files: [],
      bindingEffects: [],
      metadataEffects: [{ skillId: use.skillId, location: use.location, before: use }],
      plan: {
        planId: randomUUID(),
        kind: "bridge-skill-uses",
        displayTarget: "Restore tracking",
        actions: [],
        git: { mode: "unavailable", warnings: [] },
      },
    };
    expect(parseEffectStep(step).metadataEffects).toEqual(step.metadataEffects);
    expect(() =>
      parseEffectStep({ ...step, metadataEffects: [{ skillId: use.skillId, location: use.location, after: use }] }),
    ).toThrow("exact scope");
  });
  it("accepts equivalent receipt representations while rejecting different source identities", () => {
    const original = copy("codex");
    expect(matchesBindingSourceRepresentation(original.binding, original.source)).toBe(true);
    expect(matchesBindingSourceRepresentation({ ...original.binding, packageId: "tools" }, original.source)).toBe(true);
    expect(
      matchesBindingSourceRepresentation(
        { ...original.binding, artifactPath: "packages/tools/skills/demo/SKILL.md" },
        original.source,
      ),
    ).toBe(true);
    expect(matchesBindingSourceRepresentation({ ...original.binding, sourceId: "other-source" }, original.source)).toBe(
      false,
    );
    expect(matchesBindingSourceRepresentation({ ...original.binding, packageId: "other/tools" }, original.source)).toBe(
      false,
    );
    expect(
      matchesBindingSourceRepresentation({ ...original.binding, artifactPath: "skills/other" }, original.source),
    ).toBe(false);
  });
});
