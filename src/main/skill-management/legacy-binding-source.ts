import type { Binding } from "../../domain/assignment-plan";
import type { InventorySnapshot, ObservedPackage } from "../../domain/inventory";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import { packageSkillArtifactPath } from "./adoption-reader";

export type LegacySourceResolution =
  | Readonly<{ status: "resolved"; source: SourceSkillRef }>
  | Readonly<{ status: "unavailable"; code: "package-unavailable" | "skill-unavailable"; message: string }>;

function resolvePackage(packages: readonly ObservedPackage[], packageId: string): ObservedPackage | undefined {
  const exact = packages.filter(({ id, relativeRoot }) => id === packageId || relativeRoot === packageId);
  const candidates = exact.length
    ? exact
    : packageId.includes("/")
      ? []
      : packages.filter(
          ({ id, relativeRoot }) => id.split("/").at(-1) === packageId || relativeRoot.split("/").at(-1) === packageId,
        );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function resolveLegacyBindingSource(binding: Binding, inventory: InventorySnapshot): LegacySourceResolution {
  const pkg = resolvePackage(inventory.packages ?? [], binding.packageId);
  if (!pkg)
    return {
      status: "unavailable",
      code: "package-unavailable",
      message: `Package ${binding.packageId} is missing or ambiguous in source ${binding.sourceId}.`,
    };
  const folder = binding.artifactPath.replace(/\/SKILL\.md$/u, "");
  const candidates = inventory.artifacts.flatMap((artifact) => {
    if (
      artifact.kind !== "skill" ||
      !pkg.artifactIds.includes(artifact.id) ||
      (artifact.packageId !== undefined && artifact.packageId !== pkg.id)
    )
      return [];
    const relative = packageSkillArtifactPath(pkg.relativeRoot, artifact.relativePath);
    if (!relative || (folder !== relative && folder !== artifact.relativePath.replace(/\/SKILL\.md$/u, ""))) return [];
    if (
      artifact.scope !== "source" ||
      artifact.symlinkState !== "none" ||
      artifact.projectionPaths.length !== 1 ||
      artifact.projectionPaths[0] !== artifact.relativePath
    )
      return [];
    return [{ sourceId: binding.sourceId, packageId: pkg.id, artifactPath: relative }];
  });
  return candidates.length === 1
    ? { status: "resolved", source: candidates[0]! }
    : {
        status: "unavailable",
        code: "skill-unavailable",
        message: `Skill ${binding.artifactPath} is missing, unsafe or ambiguous in package ${pkg.id}, source ${binding.sourceId}.`,
      };
}
