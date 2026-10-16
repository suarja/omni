import { createLocalInventoryPort } from "../adapters/inventory/local-filesystem";
import { detectSourceLayout } from "../adapters/inventory/source-layout";
import type { InventoryArtifactKind } from "../domain/inventory";
import type { TargetKind } from "../domain/harness-targets";
import type { RegistryGrant } from "./registry-ipc";
import { resolveUnitFromGrant, type ResolvedUnit } from "./assignment-resolution";

const TARGET_KINDS: readonly InventoryArtifactKind[] = [
  "skill",
  "instruction",
  "command",
  "agent",
  "hook",
  "mcp-config",
];

function hasHarnessTarget(kind: InventoryArtifactKind): kind is TargetKind {
  return TARGET_KINDS.includes(kind);
}

export type PackageUnit = Readonly<{ artifactPath: string; unit: ResolvedUnit["unit"] }>;

/**
 * Resolves one `AssignmentUnit` per artifact of a package, for the whole-plugin assignment
 * preview. Reuses the same source-layout inventory scan the compatibility preview relies on to
 * enumerate the package's artifacts, then resolves each one through `resolveUnitFromGrant` — the
 * exact function the single-artifact preview already uses — so the resulting `artifactPath`
 * values are byte-identical to what a single-artifact assignment would have used for the same
 * file, keeping bindings from the two flows addressing the same target consistently.
 */
export async function resolvePackageUnits(grant: RegistryGrant, packageId: string): Promise<readonly PackageUnit[]> {
  const detected = await detectSourceLayout(createLocalInventoryPort(grant.root), "source");
  const artifacts = detected.artifacts.filter(
    (artifact) => artifact.packageId === packageId && hasHarnessTarget(artifact.kind),
  );
  const resolved = await Promise.all(
    artifacts.map(async (artifact) => {
      const unit = await resolveUnitFromGrant(grant, packageId, artifact.relativePath);
      return unit ? { artifactPath: artifact.relativePath, unit: unit.unit } : undefined;
    }),
  );
  return resolved.filter((candidate): candidate is PackageUnit => candidate !== undefined);
}
