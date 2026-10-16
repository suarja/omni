import type { InventorySnapshot, ObservedArtifact } from "../../domain/inventory";
import type { ProjectSkillHarness, ProjectSkillRow, ProjectSkills } from "../../shared/project-skills-ipc";
import type { SkillIntent } from "../../shared/skill-management-ipc";
import type { ResourceSnapshot } from "../../domain/resource-catalogue";
import type { TranslationFunction } from "../i18n";

export const projectHarnesses = ["claude-code", "codex"] as const;
export const originKinds = ["mine", "external", "project-only"] as const;
export type ProjectSkillFilter = "active" | "disabled" | ProjectSkillRow["origin"]["kind"];
export type ProjectInstructions = Readonly<{
  path: string;
  aliases: readonly string[];
  agents: readonly Readonly<{ label: string; path: string }>[];
}>;
export function harnessLabel(harness: string): string {
  const labels: Readonly<Record<string, string>> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    opencode: "OpenCode",
    gemini: "Gemini",
    omni: "Omni",
  };
  return (
    labels[harness] ??
    harness
      .split(/[-_]/u)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}
export function installedProjectHarnesses(
  inventory: InventorySnapshot | undefined,
  data: ProjectSkills | null,
): readonly string[] {
  const detected = new Set([...(inventory?.harnesses ?? []), ...projectHarnesses]);
  return [...detected].filter((harness) => {
    if (data && (harness === "claude-code" || harness === "codex"))
      return data.skills.some((row) => row.agents[harness].state === "installed");
    return (inventory?.artifacts ?? []).some(
      (artifact) =>
        artifact.kind === "skill" &&
        artifact.providerIds.includes(harness) &&
        artifact.projectionPaths.some((path) => /^\.[^/]+\/skills\/[^/]+(?:\/SKILL\.md)?$/u.test(path)),
    );
  });
}
export function isActiveSkill(row: ProjectSkillRow): boolean {
  return projectHarnesses.some((harness) => row.agents[harness].state === "installed");
}
export function isDisabledSkill(row: ProjectSkillRow): boolean {
  return !isActiveSkill(row) && projectHarnesses.some((harness) => row.agents[harness].state === "disabled");
}
export function filterProjectSkills(
  rows: readonly ProjectSkillRow[],
  filter: ProjectSkillFilter,
  query: string,
): readonly ProjectSkillRow[] {
  const text = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (filter === "disabled"
        ? isDisabledSkill(row)
        : isActiveSkill(row) && (filter === "active" || row.origin.kind === filter)) &&
      (!text ||
        `${row.name} ${row.description} ${row.origin.kind === "external" ? row.origin.source : row.origin.kind === "mine" ? row.origin.label : ""}`
          .toLocaleLowerCase()
          .includes(text)),
  );
}
export function originTitle(kind: ProjectSkillRow["origin"]["kind"], t: TranslationFunction): string {
  return t(kind === "mine" ? "projectView.mine" : kind === "external" ? "projectView.external" : "projectView.local");
}
export function skillOriginLabel(row: ProjectSkillRow, t: TranslationFunction): string {
  return row.origin.kind === "mine"
    ? t("projectView.mineOrigin", { source: row.origin.label })
    : row.origin.kind === "external"
      ? t("projectView.externalOrigin", { source: row.origin.source })
      : t("projectView.local");
}
export function projectInventory(snapshot: ResourceSnapshot, projectId: string): InventorySnapshot | undefined {
  const evidence = snapshot.roots.find(
    (root) => root.entry.kind === "project" && root.entry.id === projectId,
  )?.evidence;
  return evidence?.status === "observed" ? evidence.observation.inventory : undefined;
}
function instructionPaths(artifact: ObservedArtifact): readonly string[] {
  return [...new Set([artifact.relativePath, ...artifact.projectionPaths, artifact.physicalIdentity])].filter(
    (path) =>
      /(?:^|\/)(?:CLAUDE|AGENTS|GEMINI)\.md$/u.test(path) && !path.startsWith("/") && !path.split("/").includes(".."),
  );
}
export function projectInstructions(inventory: InventorySnapshot | undefined): readonly ProjectInstructions[] {
  const byIdentity = new Map<string, string[]>();
  for (const artifact of inventory?.artifacts ?? []) {
    if (artifact.kind !== "instruction" && artifact.kind !== "rule") continue;
    const paths = instructionPaths(artifact);
    if (!paths.length) continue;
    byIdentity.set(artifact.physicalIdentity, [
      ...new Set([...(byIdentity.get(artifact.physicalIdentity) ?? []), ...paths]),
    ]);
  }
  return [...byIdentity].map(([identity, paths]) => {
    const path = paths.includes(identity) ? identity : (paths.find((path) => path.endsWith("CLAUDE.md")) ?? paths[0]!);
    const agents = paths.flatMap((path) =>
      path.endsWith("CLAUDE.md")
        ? [{ label: "Claude Code", path }]
        : path.endsWith("AGENTS.md")
          ? [{ label: "Codex", path }]
          : path.endsWith("GEMINI.md")
            ? [{ label: "Gemini", path }]
            : [],
    );
    return { path, aliases: paths.filter((alias) => alias !== path), agents };
  });
}
export function projectSkillIntent(
  projectId: string,
  row: ProjectSkillRow,
  action: "disable" | "enable" | "delete" | "install-agent" | "remove-agent",
  harness?: ProjectSkillHarness,
): SkillIntent {
  return { kind: "project-skill", projectId, rowId: row.id, action, ...(harness ? { harnessIds: [harness] } : {}) };
}
export function maintenanceIntent(projectId: string, row: ProjectSkillRow): SkillIntent | undefined {
  if (row.origin.kind !== "mine") return undefined;
  const locations = projectHarnesses.flatMap((harnessId) => {
    const agent = row.agents[harnessId];
    return agent.state === "installed" && agent.folderPath
      ? [{ projectId, harnessId, folderPath: agent.folderPath }]
      : [];
  });
  return locations.length
    ? {
        kind: "maintain-current",
        source: {
          sourceId: row.origin.sourceId,
          packageId: row.origin.packageId,
          artifactPath: row.origin.artifactPath,
        },
        locations,
      }
    : undefined;
}
export function countActiveSkills(data: ProjectSkills): number {
  return data.skills.filter(isActiveSkill).length;
}
