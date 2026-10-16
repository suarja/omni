import { useCallback, useEffect, useRef } from "react";

import type { Observation } from "../../domain/project-source-registry";
import type { ResourceRef } from "../../domain/resource-catalogue";
import type { ResourceCatalogue, ResourceRecord } from "../../domain/resource-catalogue";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { Route } from "../navigation";
import { routeForResource } from "./canvas-navigation-utils";

export function findObservedSkillVariant(
  catalogue: ResourceCatalogue,
  records: readonly ResourceRecord[],
  source: SourceSkillRef,
): ResourceRecord | undefined {
  return records.find((record) => {
    if (
      record.ref.kind !== "artifact" ||
      record.ref.entry.kind !== "source" ||
      record.ref.entry.id !== source.sourceId ||
      record.artifactKind !== "skill" ||
      record.state !== "observed" ||
      !record.relativePath
    )
      return false;
    const details = catalogue.inspect(record.ref);
    if (details?.parent?.kind !== "package" || details.parent.packageId !== source.packageId) return false;
    const packageDetails = catalogue.inspect(details.parent);
    const packageRoot = packageDetails?.resource.relativePath;
    const prefix = packageRoot === "root" || !packageRoot ? "" : `${packageRoot.replace(/\/$/u, "")}/`;
    const relativePath =
      prefix && record.relativePath.startsWith(prefix)
        ? record.relativePath.slice(prefix.length)
        : prefix
          ? ""
          : record.relativePath;
    return relativePath.replace(/\/SKILL\.md$/iu, "") === source.artifactPath;
  });
}

export function findFreshSkillVariant(observation: Observation, source: SourceSkillRef): ResourceRef | undefined {
  if (observation.subject.kind !== "source" || observation.subject.id !== source.sourceId) return undefined;
  const packages =
    observation.inventory.packages?.filter((pkg) => pkg.id === source.packageId && pkg.format === "omni") ?? [];
  if (packages.length !== 1) return undefined;
  const pkg = packages[0]!;
  const prefix = pkg.relativeRoot === "root" ? "" : `${pkg.relativeRoot.replace(/\/$/u, "")}/`;
  const matches = observation.inventory.artifacts.filter(
    (artifact) =>
      artifact.kind === "skill" &&
      pkg.artifactIds.includes(artifact.id) &&
      artifact.relativePath === `${prefix}${source.artifactPath}/SKILL.md`,
  );
  return matches.length === 1
    ? { kind: "artifact", entry: observation.subject, artifactId: matches[0]!.id }
    : undefined;
}

export function useSkillVariantNavigation(
  options: Readonly<{
    catalogue: ResourceCatalogue;
    records: readonly ResourceRecord[];
    onRefresh: () => void;
    onObserveSource?: (sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>;
    onCloseChanges: () => void;
    onNavigate: (route: Route) => void;
  }>,
): (source: SourceSkillRef) => Promise<void> {
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );
  return useCallback(
    async (source) => {
      const ticket = ++revision.current;
      const isCurrent = (): boolean => ticket === revision.current;
      const observation = await options.onObserveSource?.(source.sourceId, isCurrent);
      if (!isCurrent()) return;
      const ref = options.onObserveSource
        ? observation
          ? findFreshSkillVariant(observation, source)
          : undefined
        : findObservedSkillVariant(options.catalogue, options.records, source)?.ref;
      if (!ref)
        throw new Error(
          "The captured variant is unavailable in its current personal source. Reconnect the source and retry.",
        );
      options.onCloseChanges();
      options.onNavigate(routeForResource(ref));
    },
    [options.catalogue, options.onCloseChanges, options.onNavigate, options.onObserveSource, options.records],
  );
}
