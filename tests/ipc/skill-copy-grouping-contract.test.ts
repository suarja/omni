import { expect, test } from "vitest";
import { parseObserveSkillCopiesResponse } from "../../src/shared/skill-reconciliation-ipc";

function splitResponse() {
  const skillId = "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18";
  const locations = [
    { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/design-bank" },
    { projectId: "project-one", harnessId: "claude-code", folderPath: ".claude/skills/design-bank" },
  ];
  return {
    status: "ready",
    storeRevision: 1,
    managedUses: [],
    retainedSkills: [],
    groups: locations.map((location, index) => ({
      groupId: index === 0 ? "managed-plugin" : "individual-skills",
      correlation: {
        records: [{ skillId, label: "design-bank", evidence: "individual", locations }],
        groups: [
          {
            skillId,
            state: "unavailable",
            members: [
              {
                location,
                ref: {
                  kind: "artifact",
                  entry: { kind: "project", id: "project-one" },
                  artifactId: "artifact-" + index,
                },
                read: { status: "unavailable", reason: "denied" },
              },
            ],
            locations: locations.map((item) => ({ location: item, read: { status: "unavailable", reason: "denied" } })),
          },
        ],
        candidates: [],
      },
    })),
  };
}

test("one logical skill may span distinct physical source groups with identical remembered evidence", () => {
  const response = splitResponse();
  expect(parseObserveSkillCopiesResponse(response)).toEqual({ ...response, managedAttention: [] });
});

test("shared logical identities cannot return conflicting records or remembered reads", () => {
  const conflictingRecord = splitResponse();
  conflictingRecord.groups[1]!.correlation.records[0]!.label = "another-label";
  expect(() => parseObserveSkillCopiesResponse(conflictingRecord)).toThrow(/consistent identity evidence/);
  const conflictingRead = splitResponse();
  conflictingRead.groups[1]!.correlation.groups[0]!.locations[0]!.read.reason = "io";
  expect(() => parseObserveSkillCopiesResponse(conflictingRead)).toThrow(/consistent read evidence/);
});

test("a physical member cannot appear twice even when both groups share its logical identity", () => {
  const response = splitResponse();
  response.groups[1]!.correlation.groups[0]!.members = response.groups[0]!.correlation.groups[0]!.members;
  expect(() => parseObserveSkillCopiesResponse(response)).toThrow(/members cannot overlap/);
});
