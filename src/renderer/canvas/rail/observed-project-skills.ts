import { isWorkshopSource } from "../../../domain/source-roles";
import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { ManagedSkillUse } from "../../../domain/skill-reconciliation/types";
import type { ProjectSkills, ProjectSkillRow } from "../../../shared/project-skills-ipc";

// Incomplete inventories cannot prove that the other agent's copy is absent.
export function readObservedProjectSkills(
  snapshot: ResourceSnapshot,
  uses: readonly ManagedSkillUse[],
): readonly ProjectSkills[] {
  return snapshot.roots.flatMap((root) => {
    if (root.entry.kind !== "project" || root.evidence.status !== "observed") return [];
    const inventory = root.evidence.observation.inventory;
    if (inventory.diagnostics.some((diagnostic) => diagnostic.code !== "git-unavailable")) return [];
    const managed = uses.filter((use) => use.location.projectId === root.entry.id);
    const rows = new Map<string, ProjectSkillRow>();
    for (const artifact of inventory.artifacts) {
      if (artifact.kind !== "skill" || artifact.scope !== "project" || artifact.symlinkState === "broken") continue;
      for (const path of artifact.projectionPaths) {
        const match = /^(\.claude|\.agents)\/skills\/([^/]+)\/SKILL\.md$/u.exec(path);
        if (!match) continue;
        const folderPath = path.replace(/\/SKILL\.md$/u, "");
        const exact = managed.find((use) => use.location.folderPath === folderPath);
        if (exact?.disabled) continue;
        const use = exact ?? managed.find((use) => use.location.folderPath.split("/").at(-1) === match[2]);
        const source =
          use &&
          snapshot.registry.sources.find((source) => source.ref.id === use.source.sourceId && !source.archivedAt);
        const lock = inventory.skillOrigins?.find(
          (origin) => origin.relativePath === path || origin.artifactId === artifact.id,
        );
        const origin = use
          ? isWorkshopSource(source)
            ? { kind: "mine" as const, ...use.source, label: source.displayName }
            : { kind: "external" as const, ...use.source, source: source?.displayName ?? use.source.sourceId }
          : lock
            ? { kind: "external" as const, source: lock.source.locator }
            : { kind: "project-only" as const };
        const id = use?.skillId ?? `project-skill:${match[2]}`;
        const row = rows.get(id) ?? {
          id,
          name: match[2]!,
          description: artifact.summary ?? "",
          origin,
          state: "unknown" as const,
          agents: { "claude-code": { state: "absent" as const }, codex: { state: "absent" as const } },
        };
        const harness = match[1] === ".claude" ? "claude-code" : "codex";
        rows.set(id, {
          ...row,
          ...(use ? { skillId: use.skillId, origin } : {}),
          agents: {
            ...row.agents,
            [harness]: { state: "installed", folderPath, symlink: artifact.symlinkState !== "none" },
          },
        });
      }
    }
    const skills = [...rows.values()].map((row) => {
      const agents = { ...row.agents };
      for (const use of managed.filter((use) => use.disabled && use.skillId === row.id)) {
        const harness = use.location.harnessId;
        if (harness === "codex" || harness === "claude-code")
          agents[harness] = { state: "disabled", folderPath: use.location.folderPath };
      }
      return { ...row, agents };
    });
    return [
      {
        projectId: root.entry.id,
        skills,
        activeSkillCount: { "claude-code": 0, codex: 0 },
        startupCost: { "claude-code": 0, codex: 0 },
        diagnostics: [],
      },
    ];
  });
}
