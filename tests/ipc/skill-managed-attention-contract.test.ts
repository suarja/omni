import { describe, expect, it } from "vitest";

import { parseObserveSkillCopiesResponse } from "../../src/shared/skill-reconciliation-ipc";

const skillId = "123e4567-e89b-42d3-a456-426614174000";
const otherSkillId = "223e4567-e89b-42d3-a456-426614174000";
const location = { projectId: "project-a", harnessId: "codex", folderPath: ".agents/skills/demo" } as const;
const use = {
  skillId,
  bindingId: "binding-one",
  location,
  source: { sourceId: "source-one", packageId: "packages/tools", artifactPath: "skills/demo" },
  baseRevisionId: "323e4567-e89b-42d3-a456-426614174000",
};

function response(managedAttention?: readonly unknown[]) {
  return {
    status: "ready",
    groups: [],
    retainedSkills: [
      {
        record: { skillId, label: "demo", evidence: "individual", locations: [location] },
        locations: [{ location, read: { status: "unavailable", reason: "missing" } }],
      },
    ],
    managedUses: [use],
    ...(managedAttention === undefined ? {} : { managedAttention }),
    storeRevision: 0,
  };
}

describe("managed skill attention IPC", () => {
  it("accepts a fact tied to the exact current use", () => {
    expect(parseObserveSkillCopiesResponse(response([{ skillId, location, state: "local-change" }]))).toMatchObject({
      managedAttention: [{ skillId, location, state: "local-change" }],
    });
  });

  it("rejects foreign skill identities, locations, duplicate facts and missing facts", () => {
    expect(() =>
      parseObserveSkillCopiesResponse(response([{ skillId: otherSkillId, location, state: "local-change" }])),
    ).toThrow(/exact current use/u);
    expect(() =>
      parseObserveSkillCopiesResponse(
        response([{ skillId, location: { ...location, folderPath: ".agents/skills/other" }, state: "local-change" }]),
      ),
    ).toThrow(/exact current use/u);
    expect(() =>
      parseObserveSkillCopiesResponse(
        response([
          { skillId, location, state: "local-change" },
          { skillId, location, state: "unavailable" },
        ]),
      ),
    ).toThrow(/unique/u);
    expect(() => parseObserveSkillCopiesResponse(response([]))).toThrow(/every current managed use/u);
  });

  it("rejects unknown evidence and normalizes legacy responses without facts to an empty list", () => {
    expect(() =>
      parseObserveSkillCopiesResponse(
        response([{ skillId, location, state: "current-source-update", files: ["secret"] }]),
      ),
    ).toThrow();
    expect(parseObserveSkillCopiesResponse(response())).toMatchObject({ managedAttention: [] });
  });
});
