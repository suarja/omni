import type { ExternalSkill, ExternalSourceDetails, ExternalUse } from "../../../shared/external-library-ipc";

export type ExternalSkillTarget = Readonly<{ skillName: string; skillPath?: string; useId?: string }>;
type ResolvedSkill = Readonly<{ skill?: ExternalSkill; uses: readonly ExternalUse[]; removed?: ExternalUse }>;

function removedPeers(details: ExternalSourceDetails, selected: ExternalUse): readonly ExternalUse[] {
  return details.uses.filter(
    (use) =>
      use.state === "removed" &&
      use.skillKey === selected.skillKey &&
      (selected.skillPath ? use.skillPath === selected.skillPath : use.id === selected.id),
  );
}

export function externalSkillTargets(details: ExternalSourceDetails): readonly ExternalSkillTarget[] {
  const targets: ExternalSkillTarget[] = details.skills.map((skill) => ({
    skillName: skill.name,
    skillPath: skill.path,
  }));
  const seen = new Set<string>();
  for (const use of details.uses.filter((use) => use.state === "removed")) {
    const key = JSON.stringify([use.skillKey, use.skillPath ?? use.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ skillName: use.skillKey, skillPath: use.skillPath, useId: use.id });
  }
  return targets;
}

export function resolveExternalSkill(
  details: ExternalSourceDetails | undefined,
  target: ExternalSkillTarget,
): ResolvedSkill {
  if (!details) return { uses: [] };
  const selected = target.useId
    ? details.uses.find((use) => use.id === target.useId && use.skillKey === target.skillName)
    : undefined;
  if (target.useId && !selected) return { uses: [] };
  // A selected removed copy remains authoritative even when a same-name path is published again.
  if (selected?.state === "removed") return { uses: removedPeers(details, selected), removed: selected };
  const candidates = details.skills.filter(
    (skill) =>
      skill.name === target.skillName &&
      (target.skillPath === undefined || skill.path === target.skillPath) &&
      (!selected || skill.useIds.includes(selected.id) || skill.path === selected.skillPath),
  );
  if (candidates.length === 1) {
    const skill = candidates[0]!;
    return { skill, uses: details.uses.filter((use) => skill.useIds.includes(use.id) && use.state !== "removed") };
  }
  if (candidates.length || selected) return { uses: [] };
  const removed = details.uses.filter(
    (use) =>
      use.state === "removed" &&
      use.skillKey === target.skillName &&
      (target.skillPath === undefined || use.skillPath === target.skillPath),
  );
  const first = removed[0];
  if (!first || removed.some((use) => use.skillPath !== first.skillPath || (!first.skillPath && use.id !== first.id)))
    return { uses: [] };
  return { uses: removed, removed: first };
}

export function externalSkillTitle(details: ExternalSourceDetails, target: ExternalSkillTarget): string {
  if (externalSkillTargets(details).filter((item) => item.skillName === target.skillName).length < 2)
    return target.skillName;
  const { removed } = resolveExternalSkill(details, target);
  return `${target.skillName} · ${target.skillPath ?? removed?.folderPath ?? target.useId}`;
}
