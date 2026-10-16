import { expect, it } from "vitest";
import { comparisonFixture, detailsFixture, useFixture, createFixture } from "./external-library-fixture";
import { buildProjectGraph } from "../../src/renderer/canvas/project-graph-layout";
import { projectId } from "./project-view-fixture";
import {
  comparisonReady,
  externalReviewItems,
  needsComparison,
  useStateLabel,
  waitsForUpdate,
} from "../../src/renderer/canvas/external-library/presentation";
import { t, type TranslationFunction, type TranslationValues, type TranslationKey } from "../../src/renderer/i18n";
const french: TranslationFunction = (key: TranslationKey, values: TranslationValues = {}) => t(key, values, "fr");
it("counts only the genuine pending update beside a local-only modified copy", async () => {
  const fixture = createFixture();
  fixture.primary.uses[0]!.sourceChanged = false;
  const data = await fixture.api.readProjectSkills(projectId);
  const graph = buildProjectGraph(data, "notes-app", null, [], french, fixture.primary.uses);
  expect(graph.nodes.find((node) => node.id === "external")?.meta).toContain("1 à mettre à jour");
  expect(graph.nodes.find((node) => node.id === "external")?.meta).not.toContain("2 à mettre à jour");
});
it("retains locally modified copies without an upstream change without asking to update", () => {
  const use = { ...useFixture("local", "modified"), sourceChanged: false };
  expect(needsComparison(use)).toBe(false);
  expect(waitsForUpdate(use)).toBe(false);
  expect(useStateLabel(use, french)).toBe("Modifié ici");
  expect(externalReviewItems([{ ...detailsFixture(), uses: [use] }], "auto")).toEqual([]);
});
it("groups removed skills once across sources while automatic failures remain per use", () => {
  const one = detailsFixture(),
    two = structuredClone(one);
  two.source!.id = "fixture/second";
  two.uses = two.uses.map((use) => ({ ...use, id: `second-${use.id}`, sourceId: "fixture/second" }));
  const items = externalReviewItems([one, two], "ask");
  expect(items.filter((item) => item.kind === "removed")).toEqual([
    { key: "removed:all", kind: "removed", sourceId: "", count: 2 },
  ]);
  expect(items.filter((item) => item.kind === "update")).toHaveLength(2);
  expect(items.filter((item) => item.kind === "modified")).toHaveLength(2);
});
it("never offers missing-base choices for unknown evidence and requires every conflict choice", () => {
  const comparison = comparisonFixture("grill-me");
  expect(comparisonReady(comparison, {})).toBe(false);
  expect(comparisonReady(comparison, { "SKILL.md": "mine" })).toBe(true);
  expect(
    comparisonReady(
      { ...comparison, status: "unavailable", base: { status: "unknown", reason: "History unavailable" } },
      {},
      "source",
    ),
  ).toBe(false);
});
it("keeps stale locks from labelling a verified published removed copy as modified", () => {
  const removed = { ...useFixture("old", "removed"), copyHash: "c".repeat(64), lockStale: true as const };
  expect(useStateLabel(removed, french)).toBe("Retiré de la source");
});

it("preserves existing external folder use wires when projecting the Library hub", async () => {
  const { projectExternalLibrary } = await import("../../src/renderer/canvas/external-library/workspace");
  const projection: import("../../src/renderer/canvas/spatial/spatial-types").CanvasProjection = {
    key: "workspace",
    groups: [],
    children: [
      {
        kind: "resource",
        id: "folder",
        resource: {
          kind: "external-source",
          label: "Folder",
          ref: { kind: "entry", entry: { kind: "source", id: "folder-source" } },
          state: "observed",
          availability: "available",
        },
      },
      {
        kind: "resource",
        id: "project",
        resource: {
          kind: "project",
          label: "Project",
          ref: { kind: "entry", entry: { kind: "project", id: "project-one" } },
          state: "observed",
          availability: "available",
        },
      },
    ],
    relations: [{ from: "folder", to: "project", kind: "desired-use" }],
  };
  const result = projectExternalLibrary(projection, []);
  expect(result.relations).toHaveLength(1);
  expect(result.relations[0]!.to).toBe("project");
  expect(
    result.children.filter((node) => node.kind === "resource" && node.resource.kind === "external-source"),
  ).toHaveLength(1);
});
