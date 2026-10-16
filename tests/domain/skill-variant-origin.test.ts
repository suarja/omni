import { describe, expect, it } from "vitest";

import { parseSkillVariantOrigin } from "../../src/domain/skill-reconciliation/variant-origin";

const location = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" } as const;
const revision = {
  algorithm: "omni-tree-v1",
  hash: "a".repeat(64),
  files: [{ path: "SKILL.md", hash: "b".repeat(64), byteLength: 8 }],
} as const;
const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/upstream" } as const;
const origin = {
  schemaVersion: 1,
  variantId: "123e4567-e89b-42d3-a456-426614174000",
  forkOf: "123e4567-e89b-42d3-a456-426614174001",
  capturedAt: "2026-10-09T07:00:00.000Z",
  capturedFrom: { location, revision },
  declaredOrigin: { locator: "owner/repo", skillKey: "demo", upstreamPath: "skills/demo" },
  approvedSource: source,
  license: "MIT",
} as const;

describe("portable per-skill variant origin", () => {
  it("preserves declared and approved evidence without promoting declarations", () => {
    expect(parseSkillVariantOrigin(origin)).toEqual(origin);
    expect(parseSkillVariantOrigin({ ...origin, approvedSource: undefined })).not.toHaveProperty("approvedSource");
  });

  it("rejects path escapes, extra fields, bad revisions and non-UUID identities", () => {
    expect(() => parseSkillVariantOrigin({ ...origin, variantId: "not-a-uuid" })).toThrow();
    expect(() => parseSkillVariantOrigin({ ...origin, extra: true })).toThrow();
    expect(() =>
      parseSkillVariantOrigin({
        ...origin,
        capturedFrom: { ...origin.capturedFrom, location: { ...location, folderPath: "../outside" } },
      }),
    ).toThrow();
    expect(() =>
      parseSkillVariantOrigin({
        ...origin,
        capturedFrom: {
          ...origin.capturedFrom,
          revision: {
            ...revision,
            files: Array.from({ length: 513 }, (_, index) => ({
              path: `f-${index}`,
              hash: "a".repeat(64),
              byteLength: 0,
            })),
          },
        },
      }),
    ).toThrow();
  });
});
