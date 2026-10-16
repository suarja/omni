import type { InventorySnapshot } from "../../../domain/inventory";
import { harnessLabel, projectInstructions } from "../project-view-model";

export function countInspectedSkills(inventory: InventorySnapshot | undefined): number {
  return new Set(
    (inventory?.artifacts ?? [])
      .filter((artifact) => artifact.kind === "skill")
      .map(
        (artifact) => artifact.relativePath.match(/(?:^|\/)skills\/([^/]+)(?:\/|$)/u)?.[1] ?? artifact.physicalIdentity,
      ),
  ).size;
}
export function inspectAgentEvidence(
  inventory: InventorySnapshot | undefined,
): readonly Readonly<{ label: string; path?: string }>[] {
  const instructions = projectInstructions(inventory).flatMap((item) => item.agents);
  const paths = (inventory?.artifacts ?? []).flatMap((artifact) => [
    artifact.relativePath,
    ...artifact.projectionPaths,
  ]);
  return (inventory?.harnesses ?? []).map((harness) => {
    const label = harnessLabel(harness);
    const instruction = instructions.find((agent) => agent.label === label)?.path;
    const roots = harness === "claude-code" ? [".claude/"] : harness === "codex" ? [".agents/", ".codex/"] : [];
    const directory = roots.find((root) => paths.some((path) => path.startsWith(root)));
    const path = harness === "claude-code" ? (directory ?? instruction) : (instruction ?? directory);
    return { label, ...(path ? { path } : {}) };
  });
}
