import { describe, expect, it } from "vitest";

import { layoutCanvas } from "../../src/renderer/canvas/spatial/canvas-layout";
import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import type { CanvasProjection } from "../../src/renderer/canvas/spatial/spatial-types";
import { denseSnapshot } from "../fixtures/spatial-canvas";
import { resourceFixture } from "../fixtures/resource-catalogue";
import { projectCanvas } from "../../src/renderer/canvas/spatial/canvas-projection";

describe("spatial canvas layout", () => {
  function projectOverview(): CanvasProjection {
    const catalogue = createResourceCatalogue(denseSnapshot());
    const projection = projectCanvas(
      catalogue.browse({ kind: "entry", entry: resourceFixture.projectOneRef }),
      catalogue,
      null,
    );
    return {
      ...projection,
      children: ["group-one", "group-two", "group-three"].map((groupId) => ({
        kind: "group",
        id: groupId,
        groupId,
        label: groupId,
      })),
    };
  }

  it("connects the lower overview group through the vertical node faces", () => {
    const layout = layoutCanvas(projectOverview(), { width: 1440, height: 900 });

    expect(layout.wires[2]?.d).toBe("M 0 36 V 144");
    expect(layout.ports).toContainEqual({ x: 0, y: 36 });
    expect(layout.ports).toContainEqual({ x: 0, y: 144 });
  });

  it("preserves the accepted overview curve handles on both sides", () => {
    const layout = layoutCanvas(projectOverview(), { width: 1440, height: 900 });

    expect(layout.wires[0]?.d).toBe("M -132 0 C -187 0, -209 -130, -264 -130");
    expect(layout.wires[1]?.d).toBe("M 132 0 C 187 0, 209 -130, 264 -130");
  });

  it("uses four readable columns around a dense group center", () => {
    const catalogue = createResourceCatalogue(denseSnapshot());
    const projection = projectCanvas(
      catalogue.browse({ kind: "entry", entry: resourceFixture.projectOneRef }),
      catalogue,
      "individual-skills",
    );
    const layout = layoutCanvas(projection, { width: 1440, height: 900 });

    expect(layout.nodes).toHaveLength(40);
    expect(layout.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(new Set(layout.nodes.slice(1).map((node) => node.x))).toHaveProperty("size", 4);
    expect(layout.nodes.every((node) => Number.isFinite(node.y))).toBe(true);
    expect(layout.bounds.right - layout.bounds.left).toBeGreaterThan(1500);
    for (const a of layout.nodes)
      for (const b of layout.nodes) {
        if (a.node.id === b.node.id) continue;
        expect(Math.abs(a.x - b.x) >= 264 || Math.abs(a.y - b.y) >= 72).toBe(true);
      }
  });

  it.each([0, 1, 16, 17, 39])("keeps %i children inside finite world bounds", (count) => {
    const children = Array.from({ length: count }, (_, index) => ({
      kind: "group" as const,
      id: `child-${index}`,
      groupId: `group-${index}`,
      label: "group",
    }));
    const projection: CanvasProjection = {
      key: "project:fixture:group",
      center: { kind: "group", id: "center", groupId: "fixture", label: "group" },
      children,
      groups: [],
      relations: [],
    };
    const layout = layoutCanvas(projection, { width: 1440, height: 900 });

    expect(layout.nodes).toHaveLength(count + 1);
    expect(Object.values(layout.bounds).every(Number.isFinite)).toBe(true);
    expect(new Set(layout.nodes.slice(1).map((node) => `${node.x}:${node.y}`)).size).toBe(count);
  });

  it("keeps workspace wires limited to persisted relation endpoints", () => {
    const catalogue = createResourceCatalogue(denseSnapshot());
    const listing = catalogue.browse({ kind: "workspace" });
    const projection = projectCanvas(listing, catalogue, null);
    const layout = layoutCanvas(projection, { width: 1285, height: 907 });

    expect(layout.wires).toHaveLength(listing.relations.length);
    const emptyRelations = layoutCanvas({ ...projection, relations: [] }, { width: 1285, height: 907 });
    expect(emptyRelations.wires).toEqual([]);
  });
});
