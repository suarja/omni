import { describe, expect, it } from "vitest";

import { parseSkillUnboundResolutionRequest } from "../../src/shared/skill-unbound-resolution-request";
import { parseSkillUnboundResolutionEvidence } from "../../src/shared/skill-unbound-resolution-effects";
import { parseOperationReceipt } from "../../src/shared/operations-receipt-parsers";

const source = { sourceId: "source-tools", packageId: "tools", artifactPath: "skills/demo" };
const location = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" };
const skillId = "123e4567-e89b-42d3-a456-426614174000";
const revision = {
  algorithm: "omni-tree-v1",
  hash: "a".repeat(64),
  files: [{ path: "SKILL.md", hash: "b".repeat(64), byteLength: 4 }],
};
const evidence = {
  choice: "link-canonical",
  skillId,
  storeRevision: 5,
  record: { skillId, label: "Demo", evidence: "individual", locations: [location] },
  source: { ref: source, rootIdentity: "c".repeat(64), revision },
  local: { location, rootIdentity: "d".repeat(64), revision },
  priorManagement: { use: "absent", binding: "absent", base: "unknown" },
};

describe("unbound canonical resolution request", () => {
  it("accepts one exact location and one fully qualified source", () => {
    expect(
      parseSkillUnboundResolutionRequest({
        choice: "link-canonical",
        skillId,
        source,
        locations: [location],
      }),
    ).toEqual({ choice: "link-canonical", skillId, source, locations: [location] });
  });

  it.each([
    [{ choice: "link-canonical", skillId, source, locations: [location, location] }, "exactly one"],
    [{ choice: "link-canonical", skillId, source, locations: [{ ...location, ignored: true }] }, "unexpected field"],
    [
      {
        choice: "link-canonical",
        skillId,
        source: { sourceId: "source-tools", packageId: "tools" },
        locations: [location],
      },
      "Artifact path",
    ],
    [{ choice: "link-canonical", skillId, source, locations: [location], base: "forged" }, "unexpected field"],
    [{ choice: "link-canonical", skillId: "not-a-uuid", source, locations: [location] }, "UUID"],
  ])("rejects forged or ambiguous request %j", (request, message) => {
    expect(() => parseSkillUnboundResolutionRequest(request)).toThrow(message);
  });

  it("parses complete saved evidence and rejects invented prior management", () => {
    expect(parseSkillUnboundResolutionEvidence(evidence)).toMatchObject(evidence);
    expect(() =>
      parseSkillUnboundResolutionEvidence({
        ...evidence,
        priorManagement: { use: "present", binding: "absent", base: "unknown" },
      }),
    ).toThrow("absent-management");
    expect(() => parseSkillUnboundResolutionEvidence({ ...evidence, extra: true })).toThrow("unexpected field");
  });

  it("accepts a public link pointer only on its matching link-skill child receipt", () => {
    const intentId = "123e4567-e89b-42d3-a456-426614174010";
    const stepId = "123e4567-e89b-42d3-a456-426614174011";
    const receipt = {
      operationId: stepId,
      kind: "link-skill",
      status: "applied",
      appliedAt: "2026-10-09T12:00:00.000Z",
      displayTarget: source.artifactPath,
      actions: [],
      git: { mode: "unavailable" },
      registered: null,
      source: { kind: "source", id: source.sourceId, relativePath: source.artifactPath },
      project: { id: location.projectId },
      bindings: [
        {
          bindingId: "link-binding",
          after: {
            bindingId: "link-binding",
            sourceId: source.sourceId,
            packageId: source.packageId,
            artifactPath: source.artifactPath,
            kind: "skill",
            projectId: location.projectId,
            harnessId: location.harnessId,
            boundHash: revision.hash,
            ownedHash: revision.hash,
            createdAt: "2026-10-09T12:00:00.000Z",
          },
        },
      ],
      link: { intentId, stepId },
    };
    expect(parseOperationReceipt(receipt).link).toEqual({ intentId, stepId });
    expect(() => parseOperationReceipt({ ...receipt, adoption: { intentId, stepId } })).toThrow(
      "multiple reconciliation effects",
    );
    expect(() => parseOperationReceipt({ ...receipt, kind: "resolve-skill" })).toThrow("only valid on unbound");
  });
});
