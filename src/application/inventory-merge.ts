import {
  createObservedArtifact,
  type EvidenceConfidence,
  type ObservedArtifact,
  type SymlinkState,
} from "../domain/inventory";

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function artifactSort(left: ObservedArtifact, right: ObservedArtifact): number {
  const pathOrder = compareCodeUnits(left.relativePath, right.relativePath);
  if (pathOrder) return pathOrder;
  const kindOrder = compareCodeUnits(left.kind, right.kind);
  if (kindOrder) return kindOrder;
  return compareCodeUnits(left.physicalIdentity, right.physicalIdentity);
}

function confidenceRank(value: EvidenceConfidence): number {
  return { unknown: 0, heuristic: 1, exact: 2 }[value];
}

function mergeConfidence(artifacts: readonly ObservedArtifact[]): EvidenceConfidence {
  return artifacts.reduce(
    (result, artifact) => (confidenceRank(artifact.confidence) < confidenceRank(result) ? artifact.confidence : result),
    "exact" as EvidenceConfidence,
  );
}

function symlinkRank(value: SymlinkState): number {
  return { none: 0, "inside-root": 1, broken: 2, external: 3 }[value];
}

function mergeSymlinkState(artifacts: readonly ObservedArtifact[]): SymlinkState {
  return artifacts.reduce(
    (result, artifact) => (symlinkRank(artifact.symlinkState) > symlinkRank(result) ? artifact.symlinkState : result),
    "none" as SymlinkState,
  );
}

function sameProviderState(left: ObservedArtifact, right: ObservedArtifact): boolean {
  return JSON.stringify(left.providerState) === JSON.stringify(right.providerState);
}

export function mergePhysicalArtifacts(artifacts: readonly ObservedArtifact[]): ObservedArtifact[] {
  const groups = new Map<string, ObservedArtifact[]>();
  for (const artifact of artifacts) {
    const key = `${artifact.scope}\u0000${artifact.physicalIdentity}`;
    const group = groups.get(key) ?? [];
    group.push(artifact);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = group.slice().sort(artifactSort);
      const canonical = sorted[0];
      const providerIds = [...new Set(group.flatMap((artifact) => artifact.providerIds))].sort(compareCodeUnits);
      const projectionPaths = [
        ...new Set(
          group.flatMap((artifact) =>
            artifact.projectionPaths.includes(artifact.relativePath)
              ? artifact.projectionPaths
              : [artifact.relativePath],
          ),
        ),
      ].sort(compareCodeUnits);
      const providerState = group.every((artifact) => sameProviderState(canonical, artifact))
        ? canonical.providerState
        : undefined;
      const packageIds = [...new Set(group.flatMap((artifact) => (artifact.packageId ? [artifact.packageId] : [])))];
      const packageId = packageIds.length === 1 ? packageIds[0] : undefined;
      const summary = sorted.map((artifact) => artifact.summary).find(Boolean);

      return createObservedArtifact({
        kind: canonical.kind,
        relativePath: projectionPaths[0],
        displayPath: projectionPaths[0],
        physicalIdentity: canonical.physicalIdentity,
        projectionPaths,
        providerIds,
        scope: canonical.scope,
        confidence: mergeConfidence(group),
        symlinkState: mergeSymlinkState(group),
        ...(packageId ? { packageId } : {}),
        ...(providerState ? { providerState } : {}),
        ...(summary ? { summary } : {}),
      });
    })
    .sort(artifactSort);
}
