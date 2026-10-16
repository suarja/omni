import type { ManagedSkillUse } from "../../../domain/skill-reconciliation/types";
import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import { resourceNodeId, type CanvasProjection } from "../spatial/spatial-types";

export function addWorkspaceUseRelations(
  projection: CanvasProjection,
  snapshot: ResourceSnapshot,
  uses: readonly ManagedSkillUse[],
): CanvasProjection {
  const nodes = new Set(projection.children.map((node) => node.id));
  const relations = new Map(projection.relations.map((relation) => [`${relation.from}>${relation.to}`, relation]));
  for (const use of uses) {
    if (
      !snapshot.registry.sources.some(
        (source) => source.ref.id === use.source.sourceId && source.role !== "storefront" && !source.archivedAt,
      ) ||
      !snapshot.registry.projects.some((project) => project.ref.id === use.location.projectId && !project.archivedAt)
    )
      continue;
    const from = resourceNodeId({ kind: "entry", entry: { kind: "source", id: use.source.sourceId } });
    const to = resourceNodeId({ kind: "entry", entry: { kind: "project", id: use.location.projectId } });
    if (nodes.has(from) && nodes.has(to)) relations.set(`${from}>${to}`, { from, to, kind: "desired-use" });
  }
  return { ...projection, relations: [...relations.values()] };
}
export function workspaceObservationLocations(snapshot: ResourceSnapshot): readonly string[] {
  return snapshot.roots.flatMap((root) => {
    const entries = root.entry.kind === "project" ? snapshot.registry.projects : snapshot.registry.sources;
    const entry = entries.find((entry) => entry.ref.id === root.entry.id && !entry.archivedAt);
    const name = entry?.displayName;
    if (!name) return [];
    if (entry.availability === "missing" || entry.availability === "inaccessible") return [name];
    if (root.evidence.status === "unavailable") return [name];
    if (root.evidence.status !== "observed") return [];
    return root.evidence.observation.inventory.diagnostics
      .filter((diagnostic) => diagnostic.code !== "git-unavailable" && diagnostic.severity !== "info")
      .map((diagnostic) => `${name} · ${diagnostic.location}`);
  });
}
