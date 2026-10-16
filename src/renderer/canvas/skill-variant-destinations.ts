import { activeWorkshop } from "../../domain/source-roles";
import type { ResourceSnapshot } from "../../domain/resource-catalogue";

export type SkillVariantDestination = Readonly<{
  sourceId: string;
  sourceName: string;
  packageId: string;
  packageName: string;
}>;

export function skillVariantDestinations(snapshot: ResourceSnapshot): readonly SkillVariantDestination[] {
  return [activeWorkshop(snapshot.registry)]
    .flatMap((source) => {
      if (!source || source.availability !== "available") return [];
      const evidence = snapshot.roots.find(
        ({ entry }) => entry.kind === "source" && entry.id === source.ref.id,
      )?.evidence;
      if (!evidence || evidence.status !== "observed") return [];
      const packages = evidence.observation.inventory.packages ?? [];
      return packages
        .filter(
          (pkg) =>
            pkg.format === "omni" &&
            pkg.manifestPaths.length > 0 &&
            packages.filter(({ id }) => id === pkg.id).length === 1,
        )
        .map((pkg) => ({
          sourceId: source.ref.id,
          sourceName: source.displayName,
          packageId: pkg.id,
          packageName: pkg.displayName,
        }));
    })
    .sort((left, right) =>
      `${left.sourceName}/${left.packageName}`.localeCompare(`${right.sourceName}/${right.packageName}`),
    );
}
