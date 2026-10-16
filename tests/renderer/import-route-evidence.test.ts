import { expect, it } from "vitest";
import { findImportArtifact, findImportObservation } from "../../src/renderer/canvas/changes/import-route-evidence";
import { artifact, personalObservation, project } from "./brief-12-import-helpers";

const observation = {
  ...personalObservation,
  subject: project.ref,
  inventory: { ...personalObservation.inventory, artifacts: [artifact] },
};

it.each([artifact.relativePath, ".agents/skills/review", ".claude/skills/review", ".claude/skills/review/SKILL.md"])(
  "resolves the exact observed skill or projection at %s",
  (path) => {
    expect(findImportArtifact(observation, path)).toBe(artifact);
  },
);

it.each([".claude/skills/revie", ".claude/skills", ".claude/skills/review-other", ".claude/skills/review/references"])(
  "never treats a prefix or support directory as the requested skill at %s",
  (path) => {
    expect(findImportArtifact(observation, path)).toBeNull();
  },
);

it("does not resolve a non-skill file as a skill folder", () => {
  const command = { ...artifact, kind: "command" as const };
  expect(
    findImportArtifact(
      { ...observation, inventory: { ...observation.inventory, artifacts: [command] } },
      ".claude/skills/review",
    ),
  ).toBeNull();
});

it("uses project evidence instead of an unrelated active observation", () => {
  expect(
    findImportObservation({
      entry: project.ref,
      current: { status: "observed", observation: personalObservation },
      cached: { status: "observed", observation },
    }),
  ).toBe(observation);
});

it("does not revive stale evidence after a failed project observation", () => {
  expect(
    findImportObservation({
      entry: project.ref,
      current: null,
      cached: { status: "missing", subject: project.ref, diagnostic: "The project folder is missing." },
      root: { status: "observed", observation },
    }),
  ).toBeNull();
});

it("blocks a failed active project read even if a previous observation is cached", () => {
  expect(
    findImportObservation({
      entry: project.ref,
      current: { status: "inaccessible", subject: project.ref, diagnostic: "Access denied." },
      cached: { status: "observed", observation },
    }),
  ).toBeNull();
});

it("can reuse the exact observed canvas root when no active or cached read exists", () => {
  expect(findImportObservation({ entry: project.ref, current: null, root: { status: "observed", observation } })).toBe(
    observation,
  );
  expect(
    findImportObservation({
      entry: project.ref,
      current: null,
      root: { status: "observed", observation: personalObservation },
    }),
  ).toBeNull();
});
