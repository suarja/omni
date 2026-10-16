import { describe, expect, it } from "vitest";

import { planSkillVariantCapture } from "../../src/domain/skill-reconciliation/variant-capture";

const skillId = "123e4567-e89b-42d3-a456-426614174000";
const location = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" } as const;
const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo-personal" } as const;
const revision = {
  algorithm: "omni-tree-v1",
  hash: "a".repeat(64),
  files: [
    { path: "SKILL.md", hash: "b".repeat(64), byteLength: 8 },
    { path: "references/guide.bin", hash: "c".repeat(64), byteLength: 4 },
  ],
} as const;
const request = {
  choice: "keep-variant",
  skillId,
  locations: [location],
  destination: {
    sourceId: "personal",
    packageId: "packages/tools",
    skillKey: "demo-personal",
  },
} as const;
const record = { skillId, label: "demo", evidence: "individual", locations: [location] } as const;
const base = {
  request,
  record,
  intentId: "123e4567-e89b-42d3-a456-426614174002",
  createdAt: "2026-10-09T07:00:00.000Z",
  storeRevision: 3,
  local: { rootIdentity: "d".repeat(64), revision },
  destination: {
    source,
    rootIdentity: "e".repeat(64),
    packageRoot: "packages/tools",
    manifestPath: "packages/tools/omni.plugin.json",
    beforeManifestHash: "f".repeat(64),
    existingArtifactKeys: [],
  },
};

describe("personal variant capture policy", () => {
  it.each(["managed", "unmanaged"] as const)("captures the entire selected %s tree without project effects", (mode) => {
    const plan = planSkillVariantCapture(base);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.evidence.origin.capturedFrom).toEqual({ location, revision });
    expect(plan.evidence.origin.forkOf).toBe(skillId);
    expect(plan.evidence.origin.variantId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(plan.files.map(({ relativePath }) => relativePath)).toEqual([
      "packages/tools/skills/demo-personal/SKILL.md",
      "packages/tools/skills/demo-personal/references/guide.bin",
    ]);
    expect(plan.scope.targets).toEqual([{ projectId: "project-a", harnessId: "codex" }]);
    expect(plan.bindingEffects).toEqual([]);
    expect(plan.metadataEffects).toEqual([]);
    expect(plan.baseReferences).toEqual([]);
    expect(mode).toBeDefined();
  });

  it("allows equal bytes as a deliberate distinct key and rejects a case collision", () => {
    expect(planSkillVariantCapture(base).status).toBe("ready");
    expect(
      planSkillVariantCapture({
        ...base,
        destination: { ...base.destination, existingArtifactKeys: ["skills/DEMO-PERSONAL"] },
      }),
    ).toMatchObject({ status: "blocked", code: "destination-collision" });
  });

  it("blocks contradictory management evidence without requiring an upstream base", () => {
    expect(
      planSkillVariantCapture({
        ...base,
        use: {
          skillId,
          bindingId: "binding-a",
          location,
          source,
          baseRevisionId: "123e4567-e89b-42d3-a456-426614174003",
        },
      }),
    ).toMatchObject({ status: "blocked" });
  });
});
