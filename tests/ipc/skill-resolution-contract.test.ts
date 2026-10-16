import { describe, expect, it } from "vitest";

import { parseSkillIntent } from "../../src/shared/skill-intent-parser";
import {
  parseSkillResolutionEvidence,
  parseSkillManagedResolutionDetails,
} from "../../src/shared/skill-resolution-effects";
import { parseSkillEffectDescriptor } from "../../src/shared/skill-management-ipc";
import { parseOperationReceipt } from "../../src/shared/operations-receipt-parsers";

const skillId = "123e4567-e89b-42d3-a456-426614174000";
const baseRevisionId = "123e4567-e89b-42d3-a456-426614174001";
const location = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" } as const;
const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" } as const;
const revision = {
  algorithm: "omni-tree-v1",
  hash: "a".repeat(64),
  files: [{ path: "SKILL.md", hash: "b".repeat(64), byteLength: 8 }],
};
const binding = {
  bindingId: "binding-a",
  sourceId: source.sourceId,
  packageId: source.packageId,
  artifactPath: `${source.artifactPath}/SKILL.md`,
  kind: "skill",
  projectId: location.projectId,
  harnessId: location.harnessId,
  boundHash: revision.hash,
  ownedHash: revision.hash,
  createdAt: "2026-10-09T09:00:00.000Z",
} as const;
const use = {
  skillId,
  bindingId: binding.bindingId,
  location,
  source,
  baseRevisionId,
} as const;
const evidence = {
  choice: "use-canonical",
  skillId,
  storeRevision: 4,
  source,
  sourceTree: { rootIdentity: "c".repeat(64), revision },
  local: { location, rootIdentity: "d".repeat(64), revision },
  use,
  binding,
  base: { baseRevisionId, revision },
};
const localHash = "b".repeat(64);
const canonicalHash = "c".repeat(64);
const canonicalBaseId = "123e4567-e89b-42d3-a456-426614174002";
const changedSourceRevision = {
  ...revision,
  hash: "e".repeat(64),
  files: [{ path: "SKILL.md", hash: canonicalHash, byteLength: 9 }],
};
const changedLocalRevision = { ...revision, files: [{ path: "SKILL.md", hash: localHash, byteLength: 8 }] };
const changedEvidence = {
  ...evidence,
  sourceTree: { rootIdentity: "c".repeat(64), revision: changedSourceRevision },
  local: { ...evidence.local, revision: changedLocalRevision },
};
const nextUse = { ...use, baseRevisionId: canonicalBaseId };
const nextBinding = { ...binding, boundHash: changedSourceRevision.hash, ownedHash: changedSourceRevision.hash };
const resolutionScope = {
  sourceId: source.sourceId,
  packageId: source.packageId,
  artifactPath: source.artifactPath,
  targets: [{ projectId: location.projectId, harnessId: location.harnessId, bindingId: binding.bindingId }],
};
const beforeBase = { baseRevisionId, revision };
const afterBase = { baseRevisionId: canonicalBaseId, revision: changedSourceRevision };
const forwardStep = {
  stepId: "123e4567-e89b-42d3-a456-426614174003",
  scope: resolutionScope,
  plan: {
    planId: "123e4567-e89b-42d3-a456-426614174003",
    kind: "resolve-skill",
    displayTarget: location.folderPath,
    actions: [
      {
        kind: "write-file",
        relativePath: `${location.folderPath}/SKILL.md`,
        byteLength: 9,
        beforeHash: localHash,
        afterHash: canonicalHash,
      },
    ],
    git: { mode: "disabled", warnings: [] },
  },
  bindingEffects: [{ bindingId: binding.bindingId, before: binding, after: nextBinding }],
  files: [
    {
      rootId: location.projectId,
      relativePath: `${location.folderPath}/SKILL.md`,
      change: "change",
      byteLength: 9,
      beforeHash: localHash,
      afterHash: canonicalHash,
    },
  ],
  metadataEffects: [{ skillId, location, before: use, after: nextUse }],
  baseReferences: [beforeBase, afterBase],
  resolutionEvidence: changedEvidence,
};

describe("managed resolution contracts", () => {
  it.each(["keep-local", "use-canonical"] as const)("accepts one exact %s intent", (choice) => {
    expect(parseSkillIntent({ kind: "reconcile", request: { choice, skillId, locations: [location] } })).toEqual({
      kind: "reconcile",
      request: { choice, skillId, locations: [location] },
    });
  });

  it("rejects extra authority, empty or multiple locations", () => {
    expect(() =>
      parseSkillIntent({ kind: "reconcile", request: { choice: "keep-local", skillId, locations: [] } }),
    ).toThrow();
    expect(() =>
      parseSkillIntent({
        kind: "reconcile",
        request: { choice: "use-canonical", skillId, locations: [location, location] },
      }),
    ).toThrow();
    expect(() =>
      parseSkillIntent({
        kind: "reconcile",
        request: { choice: "use-canonical", skillId, source, locations: [location] },
      }),
    ).toThrow();
  });

  it("accepts consistent evidence for the exact selected use and source", () => {
    expect(parseSkillResolutionEvidence(evidence)).toEqual(evidence);
  });

  it("rejects evidence that substitutes a source, use, binding or base", () => {
    expect(() =>
      parseSkillResolutionEvidence({ ...evidence, source: { ...source, packageId: "packages/other" } }),
    ).toThrow();
    expect(() => parseSkillResolutionEvidence({ ...evidence, use: { ...use, bindingId: "binding-other" } })).toThrow();
    expect(() =>
      parseSkillResolutionEvidence({ ...evidence, binding: { ...binding, projectId: "project-other" } }),
    ).toThrow();
    expect(() =>
      parseSkillResolutionEvidence({ ...evidence, base: { ...evidence.base, baseRevisionId: skillId } }),
    ).toThrow();
  });

  it("requires the one selected managed target in resolution results", () => {
    expect(
      parseSkillManagedResolutionDetails({
        skillId,
        choice: "keep-local",
        targets: [{ location, bindingId: binding.bindingId, status: "retained-local" }],
      }),
    ).toMatchObject({ choice: "keep-local", targets: [{ status: "retained-local" }] });
    expect(() => parseSkillManagedResolutionDetails({ skillId, choice: "keep-local", targets: [] })).toThrow();
    expect(() =>
      parseSkillManagedResolutionDetails({
        skillId,
        choice: "keep-local",
        targets: [
          { location, bindingId: binding.bindingId, status: "applied" },
          { location, bindingId: binding.bindingId, status: "applied" },
        ],
      }),
    ).toThrow();
  });

  it("parses the complete selected-folder file transition and its exact inverse", () => {
    const forward = parseSkillEffectDescriptor({
      planId: forwardStep.stepId,
      scope: resolutionScope,
      steps: [forwardStep],
    });
    expect(forward.steps[0]?.resolutionEvidence?.choice).toBe("use-canonical");
    const inverseStep = {
      ...forwardStep,
      stepId: "123e4567-e89b-42d3-a456-426614174004",
      plan: {
        ...forwardStep.plan,
        planId: "123e4567-e89b-42d3-a456-426614174004",
        kind: "restore-apply",
        actions: [
          {
            kind: "write-file",
            relativePath: `${location.folderPath}/SKILL.md`,
            byteLength: 8,
            beforeHash: canonicalHash,
            afterHash: localHash,
          },
        ],
      },
      bindingEffects: [{ bindingId: binding.bindingId, before: nextBinding, after: binding }],
      files: [
        {
          rootId: location.projectId,
          relativePath: `${location.folderPath}/SKILL.md`,
          change: "change",
          byteLength: 8,
          beforeHash: canonicalHash,
          afterHash: localHash,
        },
      ],
      metadataEffects: [{ skillId, location, before: nextUse, after: use }],
    };
    expect(
      parseSkillEffectDescriptor({ planId: inverseStep.stepId, scope: resolutionScope, steps: [inverseStep] }).steps[0]
        ?.plan.kind,
    ).toBe("restore-apply");
  });

  it("rejects a resolution path outside the selected folder and an unlinked child receipt", () => {
    expect(() =>
      parseSkillEffectDescriptor({
        planId: forwardStep.stepId,
        scope: resolutionScope,
        steps: [
          {
            ...forwardStep,
            files: [{ ...forwardStep.files[0], relativePath: "outside/SKILL.md" }],
            plan: {
              ...forwardStep.plan,
              actions: [{ ...forwardStep.plan.actions[0], relativePath: "outside/SKILL.md" }],
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseOperationReceipt({
        operationId: forwardStep.stepId,
        kind: "resolve-skill",
        status: "applied",
        appliedAt: "2026-10-09T10:00:00.000Z",
        displayTarget: location.folderPath,
        actions: [],
        git: { mode: "disabled" },
        registered: null,
      }),
    ).toThrow();
  });
});
