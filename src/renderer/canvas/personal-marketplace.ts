import { activeWorkshop } from "../../domain/source-roles";
import type { ResourceSnapshot } from "../../domain/resource-catalogue";
import type { ObservedPackage } from "../../domain/inventory";

export type PersonalPlugin = Readonly<{
  id: string;
  name: string;
  description?: string;
  count: number;
  skillNames: readonly string[];
}>;
export function personalMarketplace(snapshot: ResourceSnapshot):
  | Readonly<{
      source: ResourceSnapshot["registry"]["sources"][number];
      inventory?: Extract<
        ResourceSnapshot["roots"][number]["evidence"],
        { status: "observed" }
      >["observation"]["inventory"];
      plugins: readonly PersonalPlugin[];
    }>
  | undefined {
  const source = activeWorkshop(snapshot.registry);
  if (!source) return undefined;
  const evidence = snapshot.roots.find(
    (root) => root.entry.kind === "source" && root.entry.id === source.ref.id,
  )?.evidence;
  const inventory = evidence?.status === "observed" ? evidence.observation.inventory : undefined;
  const packages = [...new Map((inventory?.packages ?? []).map((plugin) => [plugin.relativeRoot, plugin])).values()];
  const plugins = packages
    .map((plugin: ObservedPackage) => {
      const skills = (inventory?.artifacts ?? []).filter(
        (artifact) =>
          artifact.kind === "skill" && (plugin.artifactIds.includes(artifact.id) || artifact.packageId === plugin.id),
      );
      const skillNames = [
        ...new Set(
          skills
            .map((artifact) => artifact.relativePath.match(/(?:^|\/)skills\/([^/]+)/u)?.[1])
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      return {
        id: plugin.relativeRoot,
        name: plugin.displayName,
        description: plugin.description,
        count: skillNames.length,
        skillNames,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return { source, inventory, plugins };
}
