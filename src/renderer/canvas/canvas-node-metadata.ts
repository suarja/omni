import { activeWorkshop } from "../../domain/source-roles";
import type { ResourceSnapshot } from "../../domain/resource-catalogue";
import type { ManagedSkillUse } from "../../domain/skill-reconciliation/types";
import type { ProjectSkills } from "../../shared/project-skills-ipc";
import { translateCount, type TranslationFunction } from "../i18n";

export function canvasNodeMetadata(
  snapshot: ResourceSnapshot,
  t: TranslationFunction,
  uses: readonly ManagedSkillUse[] = [],
  cached: readonly ProjectSkills[] = [],
): ReadonlyMap<string, string> {
  const roots = [...snapshot.roots];
  for (const record of [...snapshot.registry.projects, ...snapshot.registry.sources]) {
    if (
      !record.archivedAt &&
      !roots.some((root) => root.entry.kind === record.ref.kind && root.entry.id === record.ref.id)
    )
      roots.push({ entry: record.ref, evidence: { status: "unobserved" } });
  }
  return new Map(
    roots.map((root) => {
      const ref = JSON.stringify({ kind: "entry", entry: root.entry });
      const project =
        root.entry.kind === "project" ? cached.find((data) => data.projectId === root.entry.id) : undefined;
      if (project) return [ref, translateCount(t, "projectView.skillCount", project.skills.length)];
      if (root.evidence.status !== "observed") {
        const known = uses.filter((use) => root.entry.kind === "project" && use.location.projectId === root.entry.id);
        return [
          ref,
          known.length
            ? t("canvas.managedSkillCount", { count: new Set(known.map((use) => use.skillId)).size })
            : t("canvas.notRead"),
        ];
      }
      const inventory = root.evidence.observation.inventory;
      const paths = inventory.artifacts
        .filter((artifact) => artifact.kind === "skill")
        .flatMap((artifact) =>
          root.entry.kind === "project"
            ? artifact.projectionPaths.flatMap((path) => {
                const match = /^(?:\.claude|\.agents)\/skills\/([^/]+)\/SKILL\.md$/u.exec(path);
                return match?.[1] ? [match[1]] : [];
              })
            : [artifact.physicalIdentity],
        );
      const count = new Set(paths).size;
      const personal = root.entry.kind === "source" && activeWorkshop(snapshot.registry)?.ref.id === root.entry.id;
      return [
        ref,
        personal
          ? inventory.packages
            ? t("canvas.marketplaceCount", {
                plugins: translateCount(t, "canvas.pluginCount", inventory.packages.length),
                skills: translateCount(t, "projectView.skillCount", count),
                visibility: t(
                  inventory.marketplace?.visibility === "public" ? "skillActions.public" : "skillActions.private",
                ),
              })
            : t("canvas.notRead")
          : translateCount(t, "projectView.skillCount", count),
      ];
    }),
  );
}
