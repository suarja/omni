import { routeCircuitTree } from "./circuit-tree";
import type { CanvasLayout, CanvasNode, CanvasProjection, Point, PositionedNode, Size } from "./spatial-types";

const nodeWidth = 264;
const nodeHeight = 72;

function positionChildren(children: readonly CanvasNode[]): PositionedNode[] {
  const columns = children.length > 16 ? 4 : 2;
  const perColumn = Math.max(1, Math.ceil(children.length / columns));
  const xs = columns === 4 ? [-660, -360, 360, 660] : [-360, 360];
  return children.map((node, index) => {
    const column = Math.floor(index / perColumn);
    const row = index % perColumn;
    const offset = columns === 4 && (column === 0 || column === 3) ? 64 : 0;
    return { node, x: xs[column]!, y: (row - (perColumn - 1) / 2) * 128 + offset };
  });
}

function positionWorkspace(children: readonly CanvasNode[]): PositionedNode[] {
  const sources = children.filter(
    (node) =>
      node.kind === "resource" && (node.resource.kind === "marketplace" || node.resource.kind === "external-source"),
  );
  const projects = children.filter(
    (node) =>
      (node.kind === "resource" && node.resource.kind === "project") || (node.kind === "group" && node.missingProjects),
  );
  const storefronts = children.filter((node) => node.kind === "resource" && node.resource.kind === "storefront");
  const positionedSources = positionSide(sources, -290);
  const workshop = positionedSources.find(
    (item) => item.node.kind === "resource" && item.node.resource.kind === "marketplace",
  );
  const bottom = Math.max(workshop?.y ?? 0, ...positionedSources.map((item) => item.y));
  return [
    ...positionedSources,
    ...storefronts.map((node, index) => ({ node, x: workshop?.x ?? -290, y: bottom + (index + 1) * 128 })),
    ...positionSide(projects, 290),
  ];
}

function positionSide(children: readonly CanvasNode[], x: number): PositionedNode[] {
  return children.map((node, index) => ({
    node,
    x,
    y: (index - (children.length - 1) / 2) * 128,
  }));
}

function positionOverview(children: readonly CanvasNode[], viewport: Size): PositionedNode[] {
  if (viewport.width < 620) {
    return children.map((node, index) => ({ node, x: 0, y: (index === 0 ? -1 : index) * 170 }));
  }
  const overview = [
    [-396, -130],
    [396, -130],
    [0, 180],
  ] as const;
  if (children.length <= overview.length) {
    return children.map((node, index) => ({ node, x: overview[index]![0], y: overview[index]![1] }));
  }
  return positionChildren(children);
}

function boundsFor(nodes: readonly PositionedNode[]): CanvasLayout["bounds"] {
  if (!nodes.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: Math.min(...nodes.map(({ x }) => x - nodeWidth / 2)),
    top: Math.min(...nodes.map(({ y }) => y - nodeHeight / 2)),
    right: Math.max(...nodes.map(({ x }) => x + nodeWidth / 2)),
    bottom: Math.max(...nodes.map(({ y }) => y + nodeHeight / 2)),
  };
}

function addPort(ports: Point[], point: Point): void {
  if (!ports.some((port) => port.x === point.x && port.y === point.y)) ports.push(point);
}

function wire(from: Point, to: Point, bend: number): string {
  const direction = to.x >= from.x ? 1 : -1;
  return `M ${from.x} ${from.y} C ${from.x + bend * direction} ${from.y}, ${to.x - bend * direction} ${to.y}, ${to.x} ${to.y}`;
}

type WireLayout = Readonly<{ wires: CanvasLayout["wires"]; ports: readonly Point[] }>;

function wireAttention(node: CanvasNode): Pick<CanvasLayout["wires"][number], "attention"> {
  const attention = node.attention;
  return attention && attention.state !== "quiet" ? { attention } : {};
}

export function layoutWorkspaceRelations(projection: CanvasProjection, nodes: readonly PositionedNode[]): WireLayout {
  const wires: { id: string; d: string; kind?: "publication" }[] = [];
  const ports: Point[] = [];
  for (const relation of projection.relations) {
    const from = nodes.find((node) => node.node.id === relation.from);
    const to = nodes.find((node) => node.node.id === relation.to);
    if (!from || !to) continue;
    if (relation.kind === "publication") {
      const start = { x: from.x, y: from.y + nodeHeight / 2 };
      const end = { x: to.x, y: to.y - nodeHeight / 2 };
      wires.push({
        id: `${relation.from}>${relation.to}:publication`,
        kind: "publication",
        d: `M ${start.x} ${start.y} V ${end.y}`,
      });
      continue;
    }
    const side = Math.sign(to.x - from.x) || 1;
    const start = { x: from.x + (side * nodeWidth) / 2, y: from.y };
    const end = { x: to.x - (side * nodeWidth) / 2, y: to.y };
    wires.push({
      id: `${relation.from}>${relation.to}:${relation.kind}`,
      d: wire(start, end, Math.max(36, Math.abs(end.x - start.x) * 0.42)),
    });
    addPort(ports, start);
    addPort(ports, end);
  }
  return { wires, ports };
}

function detailedWires(center: PositionedNode, children: readonly PositionedNode[]): WireLayout {
  const wires: { id: string; d: string; attention?: CanvasLayout["wires"][number]["attention"] }[] = [];
  const ports: Point[] = [];
  for (const side of [-1, 1]) {
    const group = children.filter((child) => Math.sign(child.x - center.x) === side);
    if (!group.length) continue;
    const bus = center.x + side * 220;
    const start = { x: center.x + (side * nodeWidth) / 2, y: center.y };
    const ends = group.map((child) => ({ x: child.x - (side * nodeWidth) / 2, y: child.y }));
    const tree = routeCircuitTree(start, bus, ends);
    wires.push({
      id: `trunk:${side}`,
      d: tree.trunk,
      ...wireAttention(center.node),
    });
    addPort(ports, start);
    group.forEach((child, index) => {
      wires.push({ id: `branch:${child.node.id}`, d: tree.branches[index]!, ...wireAttention(child.node) });
      addPort(ports, ends[index]!);
    });
  }
  return { wires, ports };
}

function overviewWires(center: PositionedNode, children: readonly PositionedNode[], narrow: boolean): WireLayout {
  const ports: Point[] = [];
  if (narrow && children.length) {
    const trunk = center.x + nodeWidth / 2 + 16;
    const minimum = Math.min(center.y, ...children.map((child) => child.y));
    const maximum = Math.max(center.y, ...children.map((child) => child.y));
    const centerPort = { x: center.x + nodeWidth / 2, y: center.y };
    const wires: { id: string; d: string; attention?: CanvasLayout["wires"][number]["attention"] }[] = [
      {
        id: "overview-trunk",
        d: `M ${centerPort.x} ${centerPort.y} H ${trunk} V ${minimum} M ${trunk} ${minimum} V ${maximum}`,
        ...wireAttention(center.node),
      },
    ];
    addPort(ports, centerPort);
    for (const child of children) {
      const end = { x: child.x + nodeWidth / 2, y: child.y };
      wires.push({
        id: `overview-branch:${child.node.id}`,
        d: `M ${trunk} ${child.y} H ${end.x}`,
        ...wireAttention(child.node),
      });
      addPort(ports, end);
    }
    return { wires, ports };
  }
  const wires = children.map((child) => {
    if (child.x === center.x) {
      const start = { x: center.x, y: center.y + nodeHeight / 2 };
      const end = { x: child.x, y: child.y - nodeHeight / 2 };
      addPort(ports, start);
      addPort(ports, end);
      return { id: `overview:${child.node.id}`, d: `M ${start.x} ${start.y} V ${end.y}`, ...wireAttention(child.node) };
    }
    const side = Math.sign(child.x - center.x) || 1;
    const start = { x: center.x + (side * nodeWidth) / 2, y: center.y };
    const end = { x: child.x - (side * nodeWidth) / 2, y: child.y };
    addPort(ports, start);
    addPort(ports, end);
    return { id: `overview:${child.node.id}`, d: wire(start, end, 55), ...wireAttention(child.node) };
  });
  return { wires, ports };
}

function layoutWires(projection: CanvasProjection, nodes: readonly PositionedNode[], viewport: Size): WireLayout {
  if (projection.key === "workspace") return layoutWorkspaceRelations(projection, nodes);
  if (!projection.center || !nodes.length) return { wires: [], ports: [] };
  const center = nodes[0]!;
  const children = nodes.slice(1);
  if (projection.center.kind === "group" || children.length > 3) return detailedWires(center, children);
  return overviewWires(center, children, viewport.width < 620 && children.every((child) => child.x === 0));
}

export function layoutCanvas(projection: CanvasProjection, viewport: Size): CanvasLayout {
  const positioned =
    projection.key === "workspace"
      ? positionWorkspace(projection.children)
      : projection.center
        ? [
            { node: projection.center, x: 0, y: 0 },
            ...(projection.center.kind === "group"
              ? positionChildren(projection.children)
              : projection.center.kind === "resource" &&
                  projection.center.resource.kind === "project" &&
                  projection.key.startsWith("entry:")
                ? positionOverview(projection.children, viewport)
                : positionChildren(projection.children)),
          ]
        : [];
  return {
    nodes: positioned,
    bounds: boundsFor(positioned),
    ...layoutWires(projection, positioned, viewport),
  };
}
