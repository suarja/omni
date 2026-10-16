import { expect, test } from "vitest";

import {
  parseLogicalSkillRecord,
  parseSkillDeclaration,
  parseSkillRelationshipsState,
  parseSkillRevision,
} from "../../src/domain/skill-reconciliation/validation";

const validRevision = {
  algorithm: "omni-tree-v1",
  hash: "c".repeat(64),
  files: [{ path: "SKILL.md", hash: "a".repeat(64), byteLength: 3 }],
};

test("revision validation rejects unsafe paths, duplicate files and malformed hashes", () => {
  expect(parseSkillRevision(validRevision)).toEqual(validRevision);
  expect(() =>
    parseSkillRevision({ ...validRevision, files: [{ ...validRevision.files[0], path: "../SKILL.md" }] }),
  ).toThrow();
  expect(() =>
    parseSkillRevision({ ...validRevision, files: [validRevision.files[0], validRevision.files[0]] }),
  ).toThrow();
  expect(() => parseSkillRevision({ ...validRevision, hash: "not-a-hash" })).toThrow();
  expect(() => parseSkillRevision({ ...validRevision, extra: true })).toThrow();
});

test.each(["__proto__", "constructor", "prototype"])("accepts %s in a skill declaration", (skillKey) => {
  expect(parseSkillDeclaration({ locator: "owner/repo", skillKey })).toEqual({
    locator: "owner/repo",
    skillKey,
  });
});

test("logical record validation rejects duplicate locations and management authority fields", () => {
  const location = { projectId: "p1", harnessId: "codex", folderPath: ".agents/skills/test" };
  const record = {
    skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
    label: "test",
    evidence: "individual",
    locations: [location],
    reference: validRevision,
  };
  expect(parseLogicalSkillRecord(record)).toEqual(record);
  expect(() => parseLogicalSkillRecord({ ...record, locations: [location, location] })).toThrow();
  expect(() => parseLogicalSkillRecord({ ...record, uses: [{ bindingId: "binding" }] })).toThrow();
});

test("version one relationship stores default old records to no managed uses", () => {
  expect(parseSkillRelationshipsState({ schemaVersion: 1, revision: 4, skills: [] })).toEqual({
    schemaVersion: 1,
    revision: 4,
    skills: [],
    uses: [],
  });
});

test("managed uses require an exact member, safe source, and UUID base", () => {
  const skill = {
    skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
    label: "demo",
    evidence: "individual",
    locations: [{ projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" }],
  };
  const use = {
    skillId: skill.skillId,
    bindingId: "binding-one",
    location: skill.locations[0],
    source: { sourceId: "personal-source", packageId: "owned-package", artifactPath: "skills/demo" },
    baseRevisionId: "f57f360b-57d5-4c55-9c58-332dd6eef1aa",
  };
  expect(parseSkillRelationshipsState({ schemaVersion: 1, revision: 1, skills: [skill], uses: [use] }).uses).toEqual([
    use,
  ]);
  expect(() =>
    parseSkillRelationshipsState({
      schemaVersion: 1,
      revision: 1,
      skills: [skill],
      uses: [{ ...use, location: { ...use.location, folderPath: ".agents/skills/other" } }],
    }),
  ).toThrow();
  expect(() =>
    parseSkillRelationshipsState({
      schemaVersion: 1,
      revision: 1,
      skills: [skill],
      uses: [{ ...use, baseRevisionId: "preview-base" }],
    }),
  ).toThrow();
});
