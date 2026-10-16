import { describe, expect, it } from "vitest";

import { parseSkillReconciliationRequest } from "../../src/shared/skill-reconciliation-request";
import { parseSkillDetachmentEvidence } from "../../src/shared/skill-detachment-effects";
import { parseEffectStep } from "../../src/shared/skill-management-effect-parser";
import { dispatchReconciliationRequest } from "../../src/main/skill-management/reconciliation-dispatch";
import { parseSkillOperationJournalRecord } from "../../src/main/skill-management/journal";

const location = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" } as const;
const skillId = "123e4567-e89b-42d3-a456-426614174000";
const baseRevisionId = "123e4567-e89b-42d3-a456-426614174001";
const revision = {
  algorithm: "omni-tree-v1",
  hash: "a".repeat(64),
  files: [{ path: "SKILL.md", hash: "b".repeat(64), byteLength: 12 }],
};
const source = { sourceId: "source-tools", packageId: "tools", artifactPath: "skills/demo" };
const use = { skillId, bindingId: "binding-demo", location, source, baseRevisionId };
const binding = {
  bindingId: use.bindingId,
  sourceId: source.sourceId,
  packageId: source.packageId,
  artifactPath: `${source.artifactPath}/SKILL.md`,
  kind: "skill",
  projectId: location.projectId,
  harnessId: location.harnessId,
  boundHash: revision.hash,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const evidence = {
  choice: "detach-managed",
  skillId,
  storeRevision: 4,
  record: { skillId, label: "demo", evidence: "individual", locations: [location] },
  local: {
    location,
    rootIdentity: "c".repeat(64),
    revision,
    envelope: [
      { path: ".", kind: "directory", identity: "dev:1:10" },
      { path: "SKILL.md", kind: "file", identity: "dev:1:11" },
    ],
  },
  use,
  binding,
  base: { baseRevisionId, revision },
};

function effectStep(overrides: Record<string, unknown> = {}) {
  return {
    stepId: "detach-abc",
    scope: {
      sourceId: source.sourceId,
      packageId: source.packageId,
      artifactPath: source.artifactPath,
      targets: [{ projectId: location.projectId, harnessId: location.harnessId, bindingId: binding.bindingId }],
    },
    plan: {
      planId: "detach-plan",
      kind: "detach-skill",
      displayTarget: "demo",
      actions: [],
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects: [{ bindingId: binding.bindingId, before: binding }],
    metadataEffects: [{ skillId, location, before: use }],
    files: [],
    detachmentEvidence: evidence,
    ...overrides,
  };
}

function journalRecord(stepOverrides: Record<string, unknown> = {}) {
  const step = effectStep();
  return {
    version: 1,
    intentId: "intent-d4",
    actor: { kind: "desktop" },
    intent: { kind: "reconcile", request: { choice: "detach-managed", skillId, locations: [location] } },
    status: "applying",
    effectFingerprint: "f".repeat(64),
    effect: { planId: "detach-plan", scope: step.scope, steps: [step] },
    backupReferences: [],
    steps: [{ stepId: step.stepId, status: "applying", ...stepOverrides }],
    createdAt: "2026-10-09T12:00:00.000Z",
    updatedAt: "2026-10-09T12:00:00.000Z",
  };
}

describe("skill detachment request contract", () => {
  it("accepts one exact selected location and rejects additional authority fields", () => {
    expect(parseSkillReconciliationRequest({ choice: "detach-managed", skillId, locations: [location] })).toEqual({
      choice: "detach-managed",
      skillId,
      locations: [location],
    });
    expect(() =>
      parseSkillReconciliationRequest({ choice: "detach-managed", skillId, locations: [location, location] }),
    ).toThrow();
    expect(() =>
      parseSkillReconciliationRequest({ choice: "detach-managed", skillId, locations: [location], source: {} }),
    ).toThrow();
  });

  it("dispatches stop-management through its own explicit route", () => {
    const request = { choice: "detach-managed", skillId, locations: [location] } as const;
    const result = dispatchReconciliationRequest(request, {
      adoptExact: () => "adoption",
      managedResolution: () => "resolution",
      variantCapture: () => "variant",
      unboundResolution: () => "unbound",
      detachment: () => "detachment",
    });
    expect(result).toBe("detachment");
  });

  it("parses verified detachment evidence and rejects forged identifiers or extra data", () => {
    expect(parseSkillDetachmentEvidence(evidence)).toEqual(evidence);
    expect(() => parseSkillDetachmentEvidence({ ...evidence, skillId: "not-a-uuid" })).toThrow();
    expect(() => parseSkillDetachmentEvidence({ ...evidence, source: {} })).toThrow();
    expect(() =>
      parseSkillDetachmentEvidence({ ...evidence, base: { baseRevisionId, revision: { ...revision, extra: true } } }),
    ).toThrow();
  });

  it("accepts only an exact metadata-only removal step", () => {
    const parsed = parseEffectStep(effectStep());
    expect(parsed.detachmentEvidence).toEqual(evidence);
    expect(parsed.files).toEqual([]);
    expect(parsed.bindingEffects).toEqual([{ bindingId: binding.bindingId, before: binding }]);
    expect(() =>
      parseEffectStep(
        effectStep({
          files: [{ rootId: "project-a", relativePath: ".agents/skills/demo/SKILL.md", change: "delete" }],
        }),
      ),
    ).toThrow();
    expect(() => parseEffectStep(effectStep({ adoptionEvidence: {} }))).toThrow();
    expect(() =>
      parseEffectStep(effectStep({ detachmentRestoreOrigin: { intentId: "intent", stepId: "child" } })),
    ).toThrow();
  });

  it("persists ordered management progress only for detachment journal steps", () => {
    const saved = parseSkillOperationJournalRecord(
      journalRecord({ managementProgress: { bindings: "applied", uses: "pending" } }),
    );
    expect(saved.steps[0]?.managementProgress).toEqual({ bindings: "applied", uses: "pending" });
    expect(() =>
      parseSkillOperationJournalRecord(journalRecord({ managementProgress: { bindings: "pending", uses: "applied" } })),
    ).toThrow();
    const withoutDetachment = journalRecord({ managementProgress: { bindings: "pending", uses: "pending" } });
    delete (withoutDetachment as { effect?: unknown }).effect;
    expect(() => parseSkillOperationJournalRecord(withoutDetachment)).toThrow();
  });
});
