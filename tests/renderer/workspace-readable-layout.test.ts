import { expect, it } from "vitest";
import { layoutWorkspaceMap } from "../../src/renderer/canvas/setup/workspace-map-layout";
import { deriveWorkspaceSetupProgress } from "../../src/renderer/canvas/setup/workspace-map-state";
import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import { projectCanvas } from "../../src/renderer/canvas/spatial/canvas-projection";
import type { CanvasProjection, Point } from "../../src/renderer/canvas/spatial/spatial-types";
import { project, registryView, resourceSnapshot, source } from "./workspace-setup-fixtures";

function fixture(count = 6) {
  const registry = registryView(
    Array.from({ length: count }, (_, i) => project(`app-${i}`)),
    [
      source("mine", "Mine"),
      source("external", "External", "external"),
      { ...source("store", "Store"), role: "storefront" },
    ],
  );
  const catalogue = createResourceCatalogue(resourceSnapshot(registry));
  const base = projectCanvas(catalogue.browse({ kind: "workspace" }), catalogue, null);
  const sources = base.children.filter((n) => n.kind === "resource" && n.resource.kind !== "project");
  const projects = base.children.filter((n) => n.kind === "resource" && n.resource.kind === "project");
  const projection: CanvasProjection = {
    ...base,
    relations: [
      ...base.relations,
      ...projects.flatMap((p, i) =>
        sources
          .filter((_, s) => (i + s) % 3 !== 0)
          .map((s) => ({ from: s.id, to: p.id, kind: "desired-use" as const })),
      ),
    ],
  };
  const progress = deriveWorkspaceSetupProgress(registry, null);
  return { projection, progress: { ...progress, done: { ...progress.done, agents: true }, count: 3 } };
}

// Parse the actual SVG geometry, including separate trunk subpaths.
function segments(d: string) {
  const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g)!;
  const result: (readonly [Point, Point])[] = [];
  let cursor: Point = { x: 0, y: 0 };
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]!;
    expect(["M", "H", "V", "L"], d).toContain(command);
    const next =
      command === "H"
        ? { x: Number(tokens[i++]), y: cursor.y }
        : command === "V"
          ? { x: cursor.x, y: Number(tokens[i++]) }
          : { x: Number(tokens[i++]), y: Number(tokens[i++]) };
    if (command !== "M" && (cursor.x !== next.x || cursor.y !== next.y)) result.push([cursor, next]);
    cursor = next;
  }
  return result;
}
function intersectsCard([a, b]: readonly [Point, Point], node: Point): boolean {
  return a.y === b.y
    ? a.y > node.y - 36 && a.y < node.y + 36 && Math.max(a.x, b.x) > node.x - 132 && Math.min(a.x, b.x) < node.x + 132
    : a.x > node.x - 132 && a.x < node.x + 132 && Math.max(a.y, b.y) > node.y - 36 && Math.min(a.y, b.y) < node.y + 36;
}
function overlaps([a, b]: readonly [Point, Point], [c, d]: readonly [Point, Point]): boolean {
  return a.y === b.y && c.y === d.y && a.y === c.y
    ? Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) < Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
    : a.x === b.x &&
        c.x === d.x &&
        a.x === c.x &&
        Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) < Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
}
it.each([6, 12].flatMap((count) => [1440, 1285, 320].map((width) => [count, width])))(
  "routes %i projects with orthogonal shared trees and one agents link at %i",
  (count, width) => {
    const { projection, progress } = fixture(count);
    const result = layoutWorkspaceMap(projection, { width, height: 838 }, progress, false);
    expect(result.wires.filter((w) => w.id.startsWith("agents:"))).toHaveLength(1);
    expect(result.projectFrame).toBeDefined();
    expect(new Set(result.wires.map((w) => w.id)).size).toBe(result.wires.length);
    for (const node of result.nodes.filter((n) => n.node.kind === "resource" && n.node.resource.kind === "project")) {
      expect(node.x - 132).toBeGreaterThan(result.projectFrame!.left);
      expect(node.x + 132).toBeLessThan(result.projectFrame!.right);
      expect(node.y - 36).toBeGreaterThan(result.projectFrame!.top);
      expect(node.y + 36).toBeLessThan(result.projectFrame!.bottom);
    }
    for (const relation of projection.relations)
      expect(result.wires.some((w) => w.id === `${relation.from}>${relation.to}:${relation.kind}`)).toBe(true);
    const cards = [...result.nodes, result.map!.agents!];
    for (const wire of result.wires)
      for (const segment of segments(wire.d)) {
        expect(segment[0].x === segment[1].x || segment[0].y === segment[1].y).toBe(true);
        for (const card of cards) expect(intersectsCard(segment, card), `${wire.id}: ${wire.d}`).toBe(false);
      }
    const sources = projection.children.filter((n) => n.kind === "resource" && n.resource.kind !== "project");
    for (const source of sources) {
      const tree = result.wires.filter(
        (w) => w.id.startsWith(`trunk:${source.id}:`) || w.id.startsWith(`${source.id}>`),
      );
      for (const other of sources.filter((n) => n.id !== source.id)) {
        const otherTree = result.wires.filter(
          (w) => w.id.startsWith(`trunk:${other.id}:`) || w.id.startsWith(`${other.id}>`),
        );
        for (const a of tree)
          for (const b of otherTree)
            for (const sa of segments(a.d))
              for (const sb of segments(b.d))
                expect(overlaps(sa, sb), `${a.id} / ${b.id}: ${a.d} / ${b.d}`).toBe(false);
      }
    }
    const publication = result.wires.find((w) => w.kind === "publication")!;
    expect(Math.min(...segments(publication.d).flatMap((s) => s.map((p) => p.x)))).toBeLessThan(
      Math.min(...result.nodes.map((n) => n.x - 132)),
    );
    expect(new Set(result.ports.map((p) => `${p.x}:${p.y}`)).size).toBe(result.ports.length);
  },
);

function crossingCount(
  projection: CanvasProjection,
  wires: readonly { id: string; d: string; kind?: string }[],
): number {
  const sources = projection.children.filter((n) => n.kind === "resource" && n.resource.kind !== "project");
  const trees = sources.map((source) =>
    wires
      .filter(
        (w) => w.kind !== "publication" && (w.id.startsWith(`trunk:${source.id}:`) || w.id.startsWith(`${source.id}>`)),
      )
      .flatMap((w) => segments(w.d)),
  );
  let count = 0;
  trees.forEach((tree, i) =>
    trees.slice(i + 1).forEach((other) => {
      for (const [a, b] of tree)
        for (const [c, d] of other) {
          if (
            a.y === b.y &&
            c.x === d.x &&
            c.x > Math.min(a.x, b.x) &&
            c.x < Math.max(a.x, b.x) &&
            a.y > Math.min(c.y, d.y) &&
            a.y < Math.max(c.y, d.y)
          )
            count++;
          if (
            a.x === b.x &&
            c.y === d.y &&
            a.x > Math.min(c.x, d.x) &&
            a.x < Math.max(c.x, d.x) &&
            c.y > Math.min(a.y, b.y) &&
            c.y < Math.max(a.y, b.y)
          )
            count++;
        }
    }),
  );
  return count;
}

// Match F2's real Desktop fixture, including its shared workshop/library uses.
function nativeFixture(count: number) {
  const data = fixture(count);
  const projects = data.projection.children.filter((n) => n.kind === "resource" && n.resource.kind === "project");
  const workshop = data.projection.children.find((n) => n.kind === "resource" && n.resource.kind === "marketplace")!;
  const library = data.projection.children.find((n) => n.kind === "resource" && n.resource.kind === "external-source")!;
  return {
    ...data,
    projection: {
      ...data.projection,
      children: data.projection.children.map((n) =>
        n.kind !== "resource"
          ? n
          : {
              ...n,
              resource: {
                ...n.resource,
                label:
                  n.id === workshop.id ? "acme-skills" : n.id === library.id ? "External library" : n.resource.label,
              },
            },
      ),
      relations: [
        ...data.projection.relations.filter((r) => r.kind === "publication"),
        ...projects.slice(0, 4).map((p) => ({ from: workshop.id, to: p.id, kind: "desired-use" as const })),
        ...projects.slice(2).map((p) => ({ from: library.id, to: p.id, kind: "desired-use" as const })),
      ],
    },
  };
}
it.each([6, 12].flatMap((count) => [1440, 1285, 320].map((width) => [count, width])))(
  "has no source crossings in the F2 native %i-project fixture at %i",
  (count, width) => {
    const { projection, progress } = nativeFixture(count);
    const result = layoutWorkspaceMap(projection, { width, height: 838 }, progress, false);
    expect(crossingCount(projection, result.wires)).toBe(0);
  },
);

it("keeps the visit's project slots when late relationship data changes the barycenters", async () => {
  const { createWorkspaceLayoutSession } = await import("../../src/renderer/canvas/setup/workspace-layout-session");
  const { projection, progress } = fixture();
  const layout = createWorkspaceLayoutSession();
  const size = { width: 1440, height: 838 };
  const before = layout({ ...projection, relations: [] }, size, progress, false);
  const after = layout(projection, size, progress, false);
  expect(after.nodes).toEqual(before.nodes);
  expect(after.wires.filter((w) => w.id.startsWith("agents:"))).toHaveLength(1);
});

it("retains slots across the camera's zero-size probe and a late agent observation", async () => {
  const { createWorkspaceLayoutSession } = await import("../../src/renderer/canvas/setup/workspace-layout-session");
  const { projection, progress } = fixture();
  const layout = createWorkspaceLayoutSession();
  const size = { width: 1440, height: 838 };
  const before = layout(
    { ...projection, relations: [] },
    size,
    { ...progress, done: { ...progress.done, agents: false } },
    false,
  );
  layout(projection, { width: 0, height: 0 }, progress, false);
  const after = layout(projection, size, progress, false);
  expect(after.nodes).toEqual(before.nodes);
});

it("keeps existing nodes fixed when the External library is discovered after the registry", async () => {
  const { createWorkspaceLayoutSession } = await import("../../src/renderer/canvas/setup/workspace-layout-session");
  const { projection, progress } = fixture();
  const late = projection.children.find(
    (node) => node.kind === "resource" && node.resource.kind === "external-source",
  )!;
  const layout = createWorkspaceLayoutSession(),
    size = { width: 1440, height: 838 };
  const before = layout(
    { ...projection, children: projection.children.filter((node) => node !== late) },
    size,
    progress,
    false,
  );
  const after = layout(projection, size, progress, false);
  for (const node of before.nodes)
    expect(after.nodes.find((item) => item.node.id === node.node.id)).toMatchObject({ x: node.x, y: node.y });
});

it("spreads twelve projects over several columns without changing F2 spacing", () => {
  const { projection, progress } = fixture(12);
  const result = layoutWorkspaceMap(projection, { width: 1440, height: 838 }, progress, false);
  const projects = result.nodes.filter((n) => n.node.kind === "resource" && n.node.resource.kind === "project");
  expect(new Set(projects.map((n) => n.x)).size).toBeGreaterThan(1);
  for (const a of projects)
    for (const b of projects) if (a !== b) expect(Math.abs(a.x - b.x) >= 360 || Math.abs(a.y - b.y) >= 192).toBe(true);
});

it("keeps relation attention on its branch and source attention on shared trunks", () => {
  const { projection, progress } = nativeFixture(6);
  const relation = projection.relations.find((r) => r.kind === "desired-use")!;
  const attention = {
    state: "local-change" as const,
    reasons: ["local-change" as const],
    counts: { quiet: 0, localChange: 1, copyDifference: 0, unavailable: 0 },
  };
  const result = layoutWorkspaceMap(
    {
      ...projection,
      relations: projection.relations.map((r) => (r === relation ? { ...r, attention } : r)),
      children: projection.children.map((n) => (n.id === relation.from ? { ...n, attention } : n)),
    },
    { width: 1440, height: 838 },
    progress,
    false,
  );
  expect(result.wires.find((w) => w.id === `${relation.from}>${relation.to}:${relation.kind}`)?.attention).toEqual(
    attention,
  );
  expect(
    result.wires.filter((w) => w.id.startsWith(`trunk:${relation.from}:`)).every((w) => w.attention === attention),
  ).toBe(true);
});

it("omits an empty project frame and agents wire without projects", () => {
  const { projection, progress } = nativeFixture(0);
  const result = layoutWorkspaceMap(projection, { width: 1440, height: 838 }, progress, false);
  expect(result.projectFrame).toBeUndefined();
  expect(result.wires.some((w) => w.id.startsWith("agents:"))).toBe(false);
  expect(Object.values(result.bounds).every(Number.isFinite)).toBe(true);
});
