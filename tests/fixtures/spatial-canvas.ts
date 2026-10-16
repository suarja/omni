import type { ObservedArtifact, ObservedPackage } from "../../src/domain/inventory";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";
import { resourceFixture, snapshot } from "./resource-catalogue";

export function projectSnapshot(
  artifacts: readonly ObservedArtifact[],
  packages: readonly ObservedPackage[] = [],
): ResourceSnapshot {
  const observation = resourceFixture.projectObservation;
  return {
    ...snapshot,
    roots: snapshot.roots.map((root) =>
      root.entry.kind === "project" && root.entry.id === observation.subject.id
        ? {
            ...root,
            evidence: {
              status: "observed",
              observation: {
                ...observation,
                inventory: { ...observation.inventory, artifacts, packages },
              },
            },
          }
        : root,
    ),
  };
}

export function denseSnapshot(): ResourceSnapshot {
  const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
  const artifacts = Array.from({ length: 39 }, (_, index) => {
    const path = `.agents/skills/skill-${String(index).padStart(2, "0")}/SKILL.md`;
    return {
      ...template,
      id: `dense-${index}`,
      relativePath: path,
      displayPath: path,
      physicalIdentity: path,
      projectionPaths: [path],
    };
  });
  return projectSnapshot(artifacts);
}
