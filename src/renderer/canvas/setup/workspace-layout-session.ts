import type { CanvasProjection, Size } from "../spatial/spatial-types";
import { readableWorkspaceBounds, readableWorkspaceRelations } from "../spatial/readable-workspace-layout";
import { layoutWorkspaceMap, type WorkspaceMapLayout } from "./workspace-map-layout";
import type { WorkspaceSetupProgress } from "./workspace-map-state";

/** Late relationship/metadata reads update wires and labels, never the visit's node slots. */
export function createWorkspaceLayoutSession(): (
  projection: CanvasProjection,
  viewport: Size,
  progress: WorkspaceSetupProgress,
  visible: boolean,
) => WorkspaceMapLayout {
  let saved: { key: string; layout: WorkspaceMapLayout } | undefined;
  return (projection, viewport, progress, visible) => {
    const result = layoutWorkspaceMap(projection, viewport, progress, visible);
    if (result.map?.center || viewport.width <= 0 || viewport.height <= 0) return result;
    const key = JSON.stringify(viewport);
    if (saved?.key !== key) saved = { key, layout: result };
    const positions = new Map(saved.layout.nodes.map((item) => [item.node.id, item]));
    const current = new Map(result.nodes.map((item) => [item.node.id, item.node]));
    const nodes = saved.layout.nodes
      .filter((item) => current.has(item.node.id))
      .map((item) => ({ ...item, node: current.get(item.node.id)! }));
    for (const item of result.nodes.filter((item) => !positions.has(item.node.id))) {
      let y = item.y;
      while (nodes.some((other) => Math.abs(other.x - item.x) < 264 && Math.abs(other.y - y) < 128)) y += 192;
      nodes.push({ ...item, y });
    }
    saved = { key, layout: { ...result, nodes } };
    const agents = result.map?.agents;
    return {
      ...result,
      nodes,
      bounds: readableWorkspaceBounds(nodes, agents),
      ...readableWorkspaceRelations(projection, nodes, agents),
    };
  };
}
