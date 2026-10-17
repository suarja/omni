import { expect, it } from "vitest";
import { deriveWorkspaceSetupProgress } from "../../src/renderer/canvas/setup/workspace-map-state";
import { layoutWorkspaceMap } from "../../src/renderer/canvas/setup/workspace-map-layout";
import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import { projectCanvas } from "../../src/renderer/canvas/spatial/canvas-projection";
import { fitCamera } from "../../src/renderer/canvas/spatial/camera";
import { project, registryView, resourceSnapshot, source } from "./workspace-setup-fixtures";

function layout(projectCount = 0, marketplace = false, width = 1440, agents = false, visible = true) {
  const registry = registryView(
    Array.from({ length: projectCount }, (_, i) => project(`project-${i}`)),
    marketplace ? [source("mine", "Mine")] : [],
  );
  const catalogue = createResourceCatalogue(resourceSnapshot(registry));
  const projection = projectCanvas(catalogue.browse({ kind: "workspace" }), catalogue, null);
  const size = { width, height: 838 };
  const progress = deriveWorkspaceSetupProgress(registry, null);
  const done = { ...progress.done, agents };
  return {
    size,
    result: layoutWorkspaceMap(
      projection,
      size,
      { ...progress, done, count: Object.values(done).filter(Boolean).length },
      visible,
    ),
  };
}

it.each([1440, 1285, 320])("keeps every map position and fit stable when setup ends at width %i", (width) => {
  const partial = layout(1, true, width).result;
  const complete = layout(1, true, width, true, false).result;
  expect(complete.nodes).toEqual(partial.nodes);
  expect(complete.map?.center).toEqual(partial.map?.center);
  expect(complete.map?.agents).toMatchObject(partial.map!.places.find((place) => place.step === "agents")!);
  expect(complete.map?.places).toEqual([]);
  expect(complete.bounds).toEqual(partial.bounds);
  expect(complete.wires).toHaveLength(3);
  expect(complete.wires.every((wire) => !wire.dashed)).toBe(true);
});

it.each([1440, 1285, 320])("only removes unfinished places and their wires when hidden at width %i", (width) => {
  for (const [projects, marketplace, agents] of [
    [0, false, false],
    [1, false, true],
    [1, true, false],
  ] as const) {
    const shown = layout(projects, marketplace, width, agents).result;
    const hidden = layout(projects, marketplace, width, agents, false).result;
    expect(hidden.nodes).toEqual(shown.nodes);
    expect(hidden.bounds).toEqual(shown.bounds);
    expect(hidden.map?.center).toEqual(shown.map?.center);
    expect(hidden.map?.agents).toEqual(shown.map?.agents);
    expect(hidden.map?.places).toEqual([]);
    expect(hidden.wires).toEqual(shown.wires.filter((wire) => !wire.dashed));
    expect(shown.wires.filter((wire) => wire.dashed)).toHaveLength(
      3 - Number(projects > 0) - Number(marketplace) - Number(agents),
    );
  }
});

it("keeps the center and connects all source and project nodes in a dense workspace", () => {
  const registry = registryView(
    Array.from({ length: 8 }, (_, index) => project(`app-${index}`)),
    [
      source("mine", "Mine"),
      source("other", "Other"),
      source("external", "External", "external"),
      { ...source("store", "Store"), role: "storefront" },
    ],
  );
  const catalogue = createResourceCatalogue(resourceSnapshot(registry));
  const projection = projectCanvas(catalogue.browse({ kind: "workspace" }), catalogue, null);
  const progress = deriveWorkspaceSetupProgress(registry, null);
  const shown = layoutWorkspaceMap(projection, { width: 1440, height: 838 }, progress, true);
  const hidden = layoutWorkspaceMap(projection, { width: 1440, height: 838 }, progress, false);
  expect(hidden.nodes).toEqual(shown.nodes);
  expect(hidden.map?.center).toEqual({ x: 0, y: 0 });
  expect(hidden.bounds.left).toBe(-hidden.bounds.right);
  for (const item of hidden.nodes) {
    expect(Math.abs(item.x)).toBe(404);
    expect(hidden.wires.some((wire) => wire.id === `workspace:${item.node.id}` && !wire.dashed)).toBe(true);
    expect(item.y + 36).toBeLessThanOrEqual(hidden.bounds.bottom);
  }
});

it("replaces places with real nodes at their reserved centers in either order", () => {
  const initial = layout().result.map!.places;
  for (const [count, marketplace, kind, step] of [
    [1, false, "project", "project"],
    [0, true, "marketplace", "marketplace"],
  ] as const) {
    const { result } = layout(count, marketplace);
    const slot = initial.find((slot) => slot.step === step)!;
    expect(
      result.nodes.find((node) => node.node.kind === "resource" && node.node.resource.kind === kind),
    ).toMatchObject({ x: slot.x, y: slot.y });
    expect(result.map!.places.some((slot) => slot.step === step)).toBe(false);
  }
});

it("fits the complete setup card geometry and center at both desktop acceptance widths", () => {
  for (const width of [1285, 1440]) {
    const { result, size } = layout(0, false, width);
    const camera = fitCamera(result.bounds, size);
    for (const slot of result.map!.places) {
      expect(camera.x + (slot.x - slot.width / 2) * camera.scale).toBeGreaterThanOrEqual(0);
      expect(camera.x + (slot.x + slot.width / 2) * camera.scale).toBeLessThanOrEqual(width);
      expect(camera.y + (slot.y - slot.height / 2) * camera.scale).toBeGreaterThanOrEqual(220);
      expect(camera.y + (slot.y + slot.height / 2) * camera.scale).toBeLessThanOrEqual(size.height);
    }
  }
});

it("keeps narrow setup places and center within the fit viewport horizontally", () => {
  const { result, size } = layout(0, false, 320);
  const camera = fitCamera(result.bounds, size);
  const center = result.map!.center!;
  expect(camera.x + (center.x - 75) * camera.scale).toBeGreaterThanOrEqual(0);
  expect(camera.x + (center.x + 75) * camera.scale).toBeLessThanOrEqual(size.width);
  for (const slot of result.map!.places) {
    expect(camera.x + (slot.x - slot.width / 2) * camera.scale).toBeGreaterThanOrEqual(0);
    expect(camera.x + (slot.x + slot.width / 2) * camera.scale).toBeLessThanOrEqual(size.width);
  }
});

it("keeps additional projects clear of the agent place and includes every node in fit bounds", () => {
  const { result } = layout(5);
  const agentSlot = result.map!.places.find((place) => place.step === "agents")!;
  for (const node of result.nodes) {
    expect(
      node.x + 132 < agentSlot.x - agentSlot.width / 2 ||
        node.y + 36 < agentSlot.y - agentSlot.height / 2 ||
        node.x - 132 > agentSlot.x + agentSlot.width / 2,
    ).toBe(true);
    expect(node.y - 36).toBeGreaterThanOrEqual(result.bounds.top);
    expect(node.y + 36).toBeLessThanOrEqual(result.bounds.bottom);
  }
});

it("fills the marketplace slot with the personal node even when an external source comes first", () => {
  const registry = registryView([], [source("external", "External", "external"), source("mine", "Mine")]);
  const catalogue = createResourceCatalogue(resourceSnapshot(registry));
  const projection = projectCanvas(catalogue.browse({ kind: "workspace" }), catalogue, null);
  const result = layoutWorkspaceMap(
    projection,
    { width: 1440, height: 838 },
    deriveWorkspaceSetupProgress(registry, null),
    true,
  );
  expect(
    result.nodes.find((item) => item.node.kind === "resource" && item.node.resource.kind === "marketplace"),
  ).toMatchObject({ x: -404, y: -68 });
});

it("retains observed relations when setup adds its dashed wires", () => {
  const registry = registryView([project("app")], [source("mine", "Mine")]);
  const catalogue = createResourceCatalogue(resourceSnapshot(registry));
  const projection = projectCanvas(catalogue.browse({ kind: "workspace" }), catalogue, null);
  const from = projection.children[0]!.id;
  const to = projection.children[1]!.id;
  const result = layoutWorkspaceMap(
    { ...projection, relations: [{ from, to, kind: "desired-use" }] },
    { width: 1440, height: 838 },
    deriveWorkspaceSetupProgress(registry, null),
    true,
  );
  expect(result.wires.some((wire) => wire.id === `${from}>${to}:desired-use`)).toBe(true);
});

it("keeps multiple real projects separate from the remaining narrow setup places", () => {
  const { result } = layout(3, false, 320);
  for (const node of result.nodes)
    for (const slot of result.map!.places)
      expect(node.y + 36 <= slot.y - slot.height / 2 || node.y - 36 >= slot.y + slot.height / 2).toBe(true);
});

it("keeps an existing external source clear of the unfinished marketplace place", () => {
  const registry = registryView([], [source("external", "External", "external")]);
  const catalogue = createResourceCatalogue(resourceSnapshot(registry));
  const projection = projectCanvas(catalogue.browse({ kind: "workspace" }), catalogue, null);
  for (const width of [1440, 320]) {
    const result = layoutWorkspaceMap(
      projection,
      { width, height: 838 },
      deriveWorkspaceSetupProgress(registry, null),
      true,
    );
    const place = result.map!.places.find((place) => place.step === "marketplace")!;
    for (const node of result.nodes) expect(node.y - 36).toBeGreaterThanOrEqual(place.y + place.height / 2);
  }
});
