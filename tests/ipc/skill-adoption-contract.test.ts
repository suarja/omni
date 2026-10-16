import { expect, test } from "vitest";

import { parseSkillIntent, parseSkillPreview, parseSkillResult } from "../../src/shared/skill-management-ipc";
import { parseSkillAdoptionRequest } from "../../src/shared/skill-reconciliation-request";

const source = {
  sourceId: "personal-source",
  packageId: "owned-package",
  artifactPath: "skills/demo",
};
const skillId = "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18";
const codex = {
  projectId: "project-one",
  harnessId: "codex",
  folderPath: ".agents/skills/demo",
};

test("adoption requests normalize exact selected locations", () => {
  expect(
    parseSkillAdoptionRequest({
      choice: "adopt-exact",
      skillId,
      source,
      locations: [codex],
    }),
  ).toEqual({ choice: "adopt-exact", skillId, source, locations: [codex] });
  expect(
    parseSkillIntent({ kind: "reconcile", request: { choice: "adopt-exact", skillId, source, locations: [codex] } }),
  ).toMatchObject({
    kind: "reconcile",
    request: { skillId, source, locations: [codex] },
  });
});

test("adoption requests reject unsafe, ambiguous, or unsupported selections", () => {
  const request = { choice: "adopt-exact", skillId, source, locations: [codex] };
  expect(() => parseSkillAdoptionRequest({ ...request, extra: true })).toThrow();
  expect(() => parseSkillAdoptionRequest({ ...request, skillId: "not-a-uuid" })).toThrow();
  expect(() => parseSkillAdoptionRequest({ ...request, source: { ...source, artifactPath: "../demo" } })).toThrow();
  expect(() => parseSkillAdoptionRequest({ ...request, choice: "keep-local" })).toThrow();
  expect(() => parseSkillAdoptionRequest({ ...request, locations: [codex, codex] })).toThrow();
  expect(() =>
    parseSkillAdoptionRequest({ ...request, locations: [codex, { ...codex, harnessId: "claude-code" }] }),
  ).toThrow();
  expect(() =>
    parseSkillAdoptionRequest({
      ...request,
      locations: [
        codex,
        { ...codex, projectId: "project-two", harnessId: "claude-code", folderPath: ".claude/skills/demo" },
      ],
    }),
  ).toThrow();
});

test("ready adoption preview and attributed result retain exact metadata evidence", () => {
  const revision = { algorithm: "omni-tree-v1", hash: "a".repeat(64), files: [] };
  const baseRevisionId = "f57f360b-57d5-4c55-9c58-332dd6eef1aa";
  const use = { skillId, bindingId: "binding-one", location: codex, source, baseRevisionId };
  const binding = {
    bindingId: "binding-one",
    sourceId: source.sourceId,
    packageId: source.packageId,
    artifactPath: `${source.artifactPath}/SKILL.md`,
    kind: "skill",
    projectId: codex.projectId,
    harnessId: codex.harnessId,
    boundHash: revision.hash,
    ownedHash: revision.hash,
    createdAt: "2026-10-08T10:00:00.000Z",
  };
  const scope = {
    sourceId: source.sourceId,
    packageId: source.packageId,
    artifactPath: source.artifactPath,
    targets: [{ projectId: codex.projectId, harnessId: codex.harnessId, bindingId: binding.bindingId }],
  };
  const step = {
    stepId: "adoption-step",
    scope,
    plan: {
      planId: "adoption-plan",
      kind: "skill-management",
      displayTarget: "project-one",
      actions: [],
      git: { mode: "disabled", warnings: [] },
    },
    bindingEffects: [{ bindingId: binding.bindingId, after: binding }],
    files: [],
    metadataEffects: [{ skillId, location: codex, after: use }],
    baseReferences: [{ baseRevisionId, revision }],
    adoptionEvidence: {
      storeRevision: 1,
      source: { ref: source, rootIdentity: "b".repeat(64), revision },
      locals: [{ location: codex, rootIdentity: "c".repeat(64), revision }],
    },
  };
  const preview = parseSkillPreview({
    status: "ready",
    intentId: "adoption-intent",
    planId: "adoption-plan",
    effectFingerprint: "d".repeat(64),
    scope,
    steps: [step],
  });
  expect(preview.status).toBe("ready");
  if (preview.status === "ready") expect(preview.steps[0]?.metadataEffects).toEqual(step.metadataEffects);
  expect(
    parseSkillResult({
      intentId: "adoption-intent",
      operationId: "adoption-operation",
      status: "applied",
      source: { status: "unchanged" },
      targets: [
        {
          projectId: codex.projectId,
          harnessId: codex.harnessId,
          bindingId: binding.bindingId,
          artifactPath: binding.artifactPath,
          status: "applied",
        },
      ],
      receiptIds: [],
      issues: [],
      recoveryAvailable: false,
      resolution: {
        skillId,
        choice: "adopt-exact",
        targets: [{ location: codex, bindingId: binding.bindingId, status: "applied" }],
      },
    }).resolution,
  ).toMatchObject({ skillId, choice: "adopt-exact" });
});
