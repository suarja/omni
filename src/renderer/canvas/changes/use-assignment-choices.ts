import { useMemo } from "react";

import type { ResourceCatalogue, ResourceRecord, ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { AssignmentArtifactChoice, AssignmentProjectChoice } from "./AssignmentTargets";

export function useAssignmentChoices(
  snapshot: ResourceSnapshot,
  catalogue: ResourceCatalogue,
  records: readonly ResourceRecord[],
): Readonly<{
  projects: readonly AssignmentProjectChoice[];
  artifacts: readonly AssignmentArtifactChoice[];
  packages: readonly Readonly<{ sourceId: string; id: string; name: string }>[];
}> {
  const projects = useMemo<readonly AssignmentProjectChoice[]>(
    () =>
      snapshot.registry.projects
        .filter((project) => project.archivedAt === undefined)
        .map((project) => {
          const evidence = snapshot.roots.find(
            (root) => root.entry.kind === "project" && root.entry.id === project.ref.id,
          )?.evidence;
          const detected = evidence?.status === "observed" ? evidence.observation.inventory.harnesses : [];
          return {
            id: project.ref.id,
            name: project.displayName,
            available: project.availability === "available",
            harnesses: (["claude-code", "codex", "cursor"] as const).filter((harness) => detected.includes(harness)),
          };
        }),
    [snapshot.registry.projects, snapshot.roots],
  );
  const artifacts = useMemo<readonly AssignmentArtifactChoice[]>(
    () =>
      records.flatMap((record) => {
        if (
          record.ref.kind !== "artifact" ||
          record.ref.entry.kind !== "source" ||
          record.artifactKind !== "skill" ||
          !record.relativePath
        )
          return [];
        const details = catalogue.inspect(record.ref);
        if (details?.parent?.kind !== "package") return [];
        return [
          {
            sourceId: record.ref.entry.id,
            packageId: details.parent.packageId,
            artifactPath: record.relativePath,
            name: record.label,
          },
        ];
      }),
    [records, catalogue],
  );
  const packages = useMemo(
    () =>
      records.flatMap((record) =>
        record.ref.kind === "package" && record.ref.entry.kind === "source"
          ? [{ sourceId: record.ref.entry.id, id: record.ref.packageId, name: record.label }]
          : [],
      ),
    [records],
  );
  return { projects, artifacts, packages };
}
