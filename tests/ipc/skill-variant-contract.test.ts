import { describe, expect, it } from "vitest";

import { parseSkillIntent } from "../../src/shared/skill-intent-parser";
import { parseSkillVariantCaptureRequest } from "../../src/shared/skill-variant-capture-request";

const skillId = "123e4567-e89b-42d3-a456-426614174000";
const location = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" } as const;
const destination = { sourceId: "personal", packageId: "packages/tools", skillKey: "demo-personal" } as const;

describe("personal skill variant capture request", () => {
  it("accepts one exact copy and an explicit existing destination", () => {
    expect(
      parseSkillVariantCaptureRequest({ choice: "keep-variant", skillId, locations: [location], destination }),
    ).toEqual({
      choice: "keep-variant",
      skillId,
      locations: [location],
      destination,
    });
    expect(
      parseSkillIntent({
        kind: "reconcile",
        request: { choice: "keep-variant", skillId, locations: [location], destination },
      }),
    ).toMatchObject({ kind: "reconcile", request: { choice: "keep-variant", destination } });
  });

  it("rejects ambiguous locations, malformed keys and caller supplied authority", () => {
    expect(() =>
      parseSkillVariantCaptureRequest({ choice: "keep-variant", skillId, locations: [], destination }),
    ).toThrow();
    expect(() =>
      parseSkillVariantCaptureRequest({
        choice: "keep-variant",
        skillId,
        locations: [location, location],
        destination,
      }),
    ).toThrow();
    expect(() =>
      parseSkillVariantCaptureRequest({
        choice: "keep-variant",
        skillId,
        locations: [location],
        destination: { ...destination, skillKey: "Demo Personal" },
      }),
    ).toThrow();
    expect(() =>
      parseSkillVariantCaptureRequest({
        choice: "keep-variant",
        skillId,
        locations: [location],
        destination,
        projectRoot: "/tmp/project",
        bytes: "forged",
      }),
    ).toThrow();
  });
});
