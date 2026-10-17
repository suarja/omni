import { projectExternalLibrary } from "../../src/renderer/canvas/external-library/workspace";
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

it.each([1440, 1285, 320])("removes the center and reserved slots once complete or hidden at width %i", (width) => {
  for (const result of [layout(1, true, width, true).result, layout(1, false, width, true, false).result]) {
    expect(result.map?.center).toBeUndefined();
    expect(result.map?.places).toEqual([]);
    expect(result.map?.agents).toBeDefined();
    expect(result.wires.some((wire) => wire.id.startsWith("workspace:") || wire.id.startsWith("setup:"))).toBe(false);
    expect(result.wires.filter((wire) => wire.id.startsWith("agents:"))).toHaveLength(1);
    expect(result.bounds.left).toBeLessThanOrEqual(Math.min(...result.nodes.map((node) => node.x - 132)) - 40);
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

it.each([1440, 1285, 320])("keeps the collapsed External library clear of unfinished setup at %i", (width) => {
  const registry = registryView([project("app")], [source("external", "Own repo", "external")]);
  const catalogue = createResourceCatalogue(resourceSnapshot(registry));
  const projection = projectExternalLibrary(
    projectCanvas(catalogue.browse({ kind: "workspace" }), catalogue, null),
    [],
  );
  const result = layoutWorkspaceMap(
    projection,
    { width, height: 838 },
    deriveWorkspaceSetupProgress(registry, null),
    true,
  );
  const place = result.map!.places.find((place) => place.step === "marketplace")!;
  expect(place.height).toBeGreaterThanOrEqual(352);
  const center = result.map!.center!;
  expect(
    Math.abs(center.x - place.x) >= 75 + place.width / 2 || Math.abs(center.y - place.y) >= 48 + place.height / 2,
  ).toBe(true);
  for (const node of result.nodes)
    expect(
      Math.abs(node.x - place.x) >= 132 + place.width / 2 || Math.abs(node.y - place.y) >= 36 + place.height / 2,
    ).toBe(true);
});
