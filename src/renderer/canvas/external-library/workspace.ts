import type { CanvasProjection } from "../spatial/spatial-types";
import { resourceNodeId } from "../spatial/spatial-types";
import type { ExternalSource } from "../../../shared/external-library-ipc";

export const externalLibraryRef = { kind: "entry", entry: { kind: "source", id: "external-library" } } as const;
export function projectExternalLibrary(
  projection: CanvasProjection,
  sources: readonly ExternalSource[],
): CanvasProjection {
  const previous = new Set(
    projection.children
      .filter((node) => node.kind === "resource" && node.resource.kind === "external-source")
      .map((node) => node.id),
  );
  const id = resourceNodeId(externalLibraryRef);
  const children = projection.children.filter((node) => !previous.has(node.id));
  children.push({
    kind: "resource",
    id,
    resource: {
      ref: externalLibraryRef,
      label: "External library",
      kind: "external-source",
      state: "observed",
      availability: "available",
    },
  });
  const projects = new Set(
    sources.flatMap((source) =>
      source.projects.map((project) => resourceNodeId({ kind: "entry", entry: { kind: "project", id: project.id } })),
    ),
  );
  for (const relation of projection.relations)
    if (previous.has(relation.from) && relation.kind === "desired-use") projects.add(relation.to);
  const relations = projection.relations.filter(
    (relation) => !previous.has(relation.from) && !previous.has(relation.to),
  );
  for (const child of children)
    if (projects.has(child.id)) relations.push({ from: id, to: child.id, kind: "desired-use" });
  return { ...projection, children, relations };
}
