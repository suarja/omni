import type { CanvasLayout, CanvasProjection, Point, PositionedNode, Size } from "../spatial/spatial-types";
import {
  positionReadableWorkspace,
  readableWorkspaceBounds,
  readableWorkspaceRelations,
} from "../spatial/readable-workspace-layout";
import { layoutCanvas, layoutWorkspaceRelations } from "../spatial/canvas-layout";
import { WORKSPACE_SETUP_STEPS, type WorkspaceSetupProgress, type WorkspaceSetupStep } from "./workspace-map-state";

export type WorkspaceSetupPlace = Point & Readonly<{ step: WorkspaceSetupStep; width: number; height: number }>;
export type WorkspaceMapGeometry = Readonly<{
  places: readonly WorkspaceSetupPlace[];
  center?: Point;
  agents?: Point;
}>;
export type WorkspaceMapLayout = CanvasLayout & Readonly<{ map?: WorkspaceMapGeometry }>;

function workspaceSetupPlaces(viewport: Size, recovery: boolean): readonly WorkspaceSetupPlace[] {
  const narrow = viewport.width > 0 && viewport.width < 800;
  return WORKSPACE_SETUP_STEPS.map((step, index) => ({
    step,
    x: narrow ? 0 : index === 0 ? -404 : index === 1 ? 404 : 0,
    y: narrow ? index * 232 + (recovery && index > 0 ? 88 : 0) : index < 2 ? -68 : 172,
    width: 350,
    height: step === "agents" ? 120 : step === "marketplace" && recovery ? 352 : 176,
  }));
}

function repositionNodes(layout: CanvasLayout, slots: readonly WorkspaceSetupPlace[]): readonly PositionedNode[] {
  const counts = {
    marketplace: layout.nodes.some((item) => item.node.kind === "resource" && item.node.resource.kind === "marketplace")
      ? 0
      : 1,
    project: 0,
  };
  let overflow = 0;
  const narrow = slots[0]!.x === slots[1]!.x;
  const ordered = [...layout.nodes].sort(
    (left, right) =>
      Number(right.node.kind === "resource" && right.node.resource.kind === "marketplace") -
      Number(left.node.kind === "resource" && left.node.resource.kind === "marketplace"),
  );
  return ordered.map((item) => {
    const project =
      item.node.kind === "group" || (item.node.kind === "resource" && item.node.resource.kind === "project");
    const step = project ? "project" : "marketplace";
    const slot = slots.find((place) => place.step === step)!;
    const row = counts[step]++;
    // Extra nodes stay in their column on desktop. On narrow canvases they follow all
    // reserved places so a second project cannot cover the remaining marketplace step.
    const y =
      narrow && row
        ? slots[2]!.y + 160 + overflow++ * 128
        : slot.y + (row ? slot.height / 2 + 68 + (row - 1) * 128 : 0);
    return { ...item, x: slot.x, y };
  });
}

function mapWire(
  id: string,
  center: Point,
  target: Point,
  dimensions: Size,
  attachment: "side" | "bottom",
): CanvasLayout["wires"][number] {
  const side = Math.sign(target.x - center.x) || 1;
  const start = attachment === "bottom" ? { x: center.x, y: center.y + 48 } : { x: center.x + side * 75, y: center.y };
  const end =
    attachment === "bottom"
      ? { x: target.x, y: target.y - dimensions.height / 2 }
      : { x: target.x - (side * dimensions.width) / 2, y: target.y };
  return {
    id,
    d:
      attachment === "bottom"
        ? `M ${start.x} ${start.y} L ${end.x} ${end.y}`
        : `M ${start.x} ${start.y} C ${start.x + side * 75} ${start.y}, ${end.x - side * 75} ${end.y}, ${end.x} ${end.y}`,
  };
}

function mapWires(nodes: readonly PositionedNode[], map: WorkspaceMapGeometry): CanvasLayout["wires"] {
  const wires = nodes.map((item) =>
    mapWire(`workspace:${item.node.id}`, map.center!, item, { width: 264, height: 72 }, "side"),
  );
  if (map.agents) {
    wires.push(mapWire("workspace:agents", map.center!, map.agents, { width: 264, height: 72 }, "bottom"));
  }
  return [
    ...wires,
    ...map.places.map((place) => ({
      ...mapWire(`setup:${place.step}`, map.center!, place, place, place.step === "agents" ? "bottom" : "side"),
      dashed: true,
    })),
  ];
}

export function layoutWorkspaceMap(
  projection: CanvasProjection,
  viewport: Size,
  progress: WorkspaceSetupProgress,
  visible: boolean,
): WorkspaceMapLayout {
  if (!visible || progress.count === 3) {
    const nodes = positionReadableWorkspace(projection, viewport);
    const right = Math.max(0, ...nodes.map((node) => node.x));
    const gap = Math.max(400, Math.min(480, viewport.width * 0.28));
    const agents = progress.done.agents ? { x: right + gap, y: 0 } : undefined;
    return {
      nodes,
      bounds: readableWorkspaceBounds(nodes, agents),
      ...readableWorkspaceRelations(projection, nodes, agents),
      map: { places: [], agents },
    };
  }
  const base = layoutCanvas(projection, viewport);
  const slots = workspaceSetupPlaces(
    viewport,
    !progress.done.marketplace &&
      base.nodes.some((item) => item.node.kind === "resource" && item.node.resource.kind === "external-source"),
  );
  const narrow = viewport.width > 0 && viewport.width < 800;
  const center = { x: 0, y: narrow ? Math.min(-180, -slots[0]!.height / 2 - 96) : 0 };
  const nodes = repositionNodes(base, slots);
  const places = visible ? slots.filter((slot) => !progress.done[slot.step]) : [];
  const agents = progress.done.agents ? slots[2] : undefined;
  const map = { places, center, agents };
  const relations = layoutWorkspaceRelations(projection, nodes);
  // Bounds include the welcome's breathing room and all reserved slots, including loading.
  // Keeping them stable makes the first registry response replace the skeleton in place.
  return {
    nodes,
    bounds: {
      left: Math.min(
        center.x - 75,
        ...slots.map((slot) => slot.x - slot.width / 2),
        ...nodes.map((node) => node.x - 132),
      ),
      right: Math.max(
        center.x + 75,
        ...slots.map((slot) => slot.x + slot.width / 2),
        ...nodes.map((node) => node.x + 132),
      ),
      top: Math.min(
        narrow ? center.y - 48 : -290,
        ...slots.map((slot) => slot.y - slot.height / 2),
        ...nodes.map((node) => node.y - 36),
      ),
      bottom: Math.max(...slots.map((slot) => slot.y + slot.height / 2), ...nodes.map((node) => node.y + 36)),
    },
    wires: [...relations.wires, ...mapWires(nodes, map)],
    ports: relations.ports,
    map,
  };
}
