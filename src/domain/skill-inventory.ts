import type { SkillInventoryIdentity, SkillInventoryReadUnit } from "../shared/skill-inventory";

function groupUnits(
  units: readonly SkillInventoryReadUnit[],
  key: (unit: SkillInventoryReadUnit) => string | null,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  units.forEach((unit, index) => {
    const value = key(unit);
    if (value !== null) groups.set(value, [...(groups.get(value) ?? []), index]);
  });
  return groups;
}
function sourceKey(unit: SkillInventoryReadUnit): string {
  const origin = unit.origin;
  return origin.kind === "marketplace"
    ? `marketplace:${origin.sourceId}:${origin.packageId}`
    : origin.kind === "external"
      ? `external:${origin.repo}:${origin.skillPath ?? unit.name}`
      : `local:${unit.scope}`;
}
export function deriveSkillInventoryIdentity(
  units: readonly SkillInventoryReadUnit[],
  staleBindings: SkillInventoryIdentity["staleBindings"],
): SkillInventoryIdentity {
  const names = groupUnits(units, (unit) => unit.name);
  const hashes = groupUnits(units, (unit) => unit.contentHash);
  const byName: Array<SkillInventoryIdentity["byName"][number]> = [];
  for (const [name, indexes] of names) {
    const members = indexes.map((index) => units[index]!);
    const kinds: Array<SkillInventoryIdentity["byName"][number]["kinds"][number]> = [];
    if (new Set(members.flatMap((unit) => (unit.contentHash ? [unit.contentHash] : []))).size > 1)
      kinds.push("sameNameDifferentContent");
    const unlinkedCopies = members.flatMap((unit) =>
      unit.scope === "marketplace" || unit.origin.kind === "marketplace" || !unit.contentHash
        ? []
        : members
            .filter((candidate) => candidate.scope === "marketplace" && candidate.contentHash)
            .map((candidate) => ({ project: unit.id, marketplace: candidate.id })),
    );
    if (unlinkedCopies.length) kinds.push("unlinkedCopies");
    if (new Set(members.map(sourceKey)).size > 1) kinds.push("multipleSources");
    if (kinds.length)
      byName.push({
        name,
        kinds,
        units: members.map((unit) => unit.id),
        hashes: Object.fromEntries(members.flatMap((unit) => (unit.contentHash ? [[unit.id, unit.contentHash]] : []))),
        ...(unlinkedCopies.length ? { unlinkedCopies } : {}),
      });
  }
  return {
    byName,
    sameContentDifferentNames: [...hashes]
      .filter(([, indexes]) => new Set(indexes.map((index) => units[index]!.name)).size > 1)
      .map(([contentHash, indexes]) => ({ contentHash, units: indexes.map((index) => units[index]!.id) })),
    staleBindings,
  };
}
