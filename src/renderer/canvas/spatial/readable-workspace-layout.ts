import { routeCircuitTree } from "./circuit-tree";
import type { CanvasLayout, CanvasNode, CanvasProjection, Point, PositionedNode, Size } from "./spatial-types";

const width = 264;
const height = 72;

function isProject(node: CanvasNode): boolean {
  return node.kind === "group" || (node.kind === "resource" && node.resource.kind === "project");
}
function compareNodes(a: CanvasNode, b: CanvasNode): number {
  const label = (node: CanvasNode): string => (node.kind === "resource" ? node.resource.label : node.id);
  return label(a).localeCompare(label(b)) || a.id.localeCompare(b.id);
}
function barycenter(node: CanvasNode, peers: readonly CanvasNode[], projection: CanvasProjection): number {
  const neighbors = projection.relations.flatMap((link) =>
    link.from === node.id ? [link.to] : link.to === node.id ? [link.from] : [],
  );
  const indexes = peers.flatMap((peer, index) => (neighbors.includes(peer.id) ? [index] : []));
  return indexes.length ? indexes.reduce((sum, index) => sum + index, 0) / indexes.length : peers.length;
}
function orderNodes(
  nodes: readonly CanvasNode[],
  peers: readonly CanvasNode[],
  projection: CanvasProjection,
): CanvasNode[] {
  return [...nodes].sort(
    (a, b) => barycenter(a, peers, projection) - barycenter(b, peers, projection) || compareNodes(a, b),
  );
}

export function positionReadableWorkspace(projection: CanvasProjection, viewport: Size): readonly PositionedNode[] {
  let sources = projection.children.filter((node) => !isProject(node)).sort(compareNodes);
  let projects = orderNodes(projection.children.filter(isProject), sources, projection);
  sources = orderNodes(sources, projects, projection);
  projects = orderNodes(projects, sources, projection);
  const aspect = Math.max(0.6, Math.min(2, viewport.width / Math.max(1, viewport.height)));
  // A populated circuit needs row gutters, including on a narrow pannable canvas.
  const columns =
    projects.length > 5 ? Math.min(3, Math.max(2, Math.round(Math.sqrt((projects.length * aspect) / 3)))) : 1;
  const rows = Math.ceil(projects.length / columns);
  const gap = Math.max(400, Math.min(480, viewport.width * 0.28));
  const sourceX = (-(columns + 1) * gap) / 2;
  return [
    ...sources.map((node, index) => ({ node, x: sourceX, y: (index - (sources.length - 1) / 2) * 192 })),
    ...projects.map((node, index) => ({
      node,
      x: sourceX + ((index % columns) + 1) * gap,
      y: (Math.floor(index / columns) - (rows - 1) / 2) * 192,
    })),
  ];
}

type Wire = CanvasLayout["wires"][number];
type Branch = Readonly<{ wire: Wire; end: Point }>;

function projectFrame(projects: readonly PositionedNode[]): CanvasLayout["projectFrame"] {
  if (!projects.length) return undefined;
  return {
    left: Math.min(...projects.map((p) => p.x - width / 2)) - 24,
    right: Math.max(...projects.map((p) => p.x + width / 2)) + 24,
    top: Math.min(0, ...projects.map((p) => p.y - height / 2)) - 48,
    bottom: Math.max(0, ...projects.map((p) => p.y + height / 2)) + 48,
  };
}

function appendTree(
  wires: Wire[],
  ports: Point[],
  id: string,
  start: Point,
  bus: number,
  branches: readonly Branch[],
  extensions: readonly Point[] = [],
  attention?: CanvasNode["attention"],
): void {
  const tree = routeCircuitTree(start, bus, [...branches.map((b) => b.end), ...extensions]);
  wires.push({ id, d: tree.trunk, ...(attention?.state !== "quiet" ? { attention } : {}) });
  branches.forEach((branch, index) => {
    wires.push({ ...branch.wire, d: tree.branches[index]! });
    ports.push(branch.end);
  });
}

function gutterFor(ends: readonly Point[], projects: readonly PositionedNode[], offset: number): number {
  const center = ends.reduce((sum, end) => sum + end.y, 0) / ends.length;
  const rows = [...new Set(projects.map((p) => p.y))].sort((a, b) => a - b);
  const lanes = [rows[0]! - 72, ...rows.slice(1).map((y, i) => (y + rows[i]!) / 2), rows.at(-1)! + 72];
  return lanes.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b)[0]! + offset;
}

function appendSourceTree(
  projection: CanvasProjection,
  projects: readonly PositionedNode[],
  sources: readonly PositionedNode[],
  columns: readonly number[],
  source: PositionedNode,
  index: number,
  wires: Wire[],
  ports: Point[],
): void {
  const links = projection.relations.flatMap((relation) => {
    const target = projects.find((p) => p.node.id === relation.to);
    if (relation.from !== source.node.id || !target || relation.kind === "publication") return [];
    return [
      {
        target,
        wire: {
          id: `${relation.from}>${relation.to}:${relation.kind}`,
          d: "",
          kind: relation.kind,
          attention: relation.attention,
        },
        end: {
          x: target.x - width / 2,
          y: target.y + ((index + 1) * (height - 16)) / (sources.length + 1) - height / 2 + 9,
        },
      },
    ];
  });
  if (!links.length) return;
  const start = { x: source.x + width / 2, y: source.y };
  const trunk = start.x + ((columns[0]! - width / 2 - start.x) * (index + 1)) / (sources.length + 1);
  const later = columns.slice(1).flatMap((column) => {
    const branches = links.filter((b) => b.target.x === column);
    if (!branches.length) return [];
    return [
      {
        column,
        branches,
        lane: gutterFor(
          branches.map((branch) => branch.end),
          projects,
          ((index + 1) / (sources.length + 1) - 0.5) * 48,
        ),
      },
    ];
  });
  appendTree(
    wires,
    ports,
    `trunk:${source.node.id}:root`,
    start,
    trunk,
    links.filter((b) => b.target.x === columns[0]),
    later.map((c) => ({ x: trunk, y: c.lane })),
    source.node.attention,
  );
  ports.push(start);
  later.forEach(({ column, branches, lane }) => {
    const bus = column - width / 2 - 32 - ((sources.length - index) / (sources.length + 1)) * 48;
    appendTree(
      wires,
      ports,
      `trunk:${source.node.id}:column:${column}`,
      { x: trunk, y: lane },
      bus,
      branches,
      [],
      source.node.attention,
    );
  });
}

export function readableWorkspaceRelations(
  projection: CanvasProjection,
  nodes: readonly PositionedNode[],
  agents?: Point,
): Pick<CanvasLayout, "wires" | "ports" | "projectFrame"> {
  const projects = nodes.filter((item) => isProject(item.node));
  const sources = nodes.filter((item) => !isProject(item.node));
  const columns = [...new Set(projects.map((p) => p.x))].sort((a, b) => a - b);
  const frame = projectFrame(projects);
  const wires: Wire[] = [],
    ports: Point[] = [];
  sources.forEach((source, index) =>
    appendSourceTree(projection, projects, sources, columns, source, index, wires, ports),
  );
  for (const relation of projection.relations.filter((r) => r.kind === "publication")) {
    const from = nodes.find((n) => n.node.id === relation.from),
      to = nodes.find((n) => n.node.id === relation.to);
    if (!from || !to) continue;
    const start = { x: from.x - width / 2, y: from.y },
      end = { x: to.x - width / 2, y: to.y };
    const gutter = Math.min(...sources.map((n) => n.x - width / 2)) - 40;
    wires.push({
      id: `${relation.from}>${relation.to}:publication`,
      kind: "publication",
      d: `M ${start.x} ${start.y} H ${gutter} V ${end.y} H ${end.x}`,
      attention: relation.attention,
    });
    ports.push(start, end);
  }
  if (agents && frame) {
    const start = { x: frame.right, y: agents.y },
      end = { x: agents.x - width / 2, y: agents.y };
    wires.push({ id: "agents:projects", d: `M ${start.x} ${start.y} H ${end.x}` });
    ports.push(start, end);
  }
  return {
    wires,
    ports: ports.filter((p, i) => ports.findIndex((q) => q.x === p.x && q.y === p.y) === i),
    ...(frame ? { projectFrame: frame } : {}),
  };
}

export function readableWorkspaceBounds(nodes: readonly PositionedNode[], agents?: Point): CanvasLayout["bounds"] {
  const points = [...nodes, ...(agents ? [agents] : [])];
  if (!points.length) return { left: 0, right: 0, top: 0, bottom: 0 };
  return {
    left: Math.min(...points.map((p) => p.x - width / 2)) - 48,
    right: Math.max(
      ...points.map((p) => p.x + width / 2),
      projectFrame(nodes.filter((item) => isProject(item.node)))?.right ?? -Infinity,
    ),
    top: Math.min(...points.map((p) => p.y - height / 2)) - 96,
    bottom: Math.max(...points.map((p) => p.y + height / 2)) + 96,
  };
}
