import type { ManagedSkillUse } from "../domain/skill-reconciliation/types";
import type { ProjectSkillRow, ProjectSkillHarness, ProjectSkills } from "../shared/project-skills-ipc";

export type ProjectSkillCopy = Readonly<{
  folderPath: string;
  harnessId: ProjectSkillHarness;
  symlink: boolean;
  name: string;
  description: string;
  use?: ManagedSkillUse;
  origin: ProjectSkillRow["origin"];
  state: ProjectSkillRow["state"];
}>;
export type ProjectSkillParkedView = Readonly<{
  rowId: string;
  harnessId: ProjectSkillHarness;
  folderPath: string;
  row: ProjectSkillRow;
}>;
const harnesses = ["claude-code", "codex"] as const;
const folderName = (path: string): string => path.split("/").at(-1)!;

function aggregateState(members: readonly ProjectSkillCopy[]): ProjectSkillRow["state"] {
  for (const state of ["removed-upstream", "modified-here", "unknown", "update-available", "current"] as const)
    if (members.some((member) => member.state === state)) return state;
  return "unknown";
}
function agentState(
  harnessId: ProjectSkillHarness,
  members: readonly ProjectSkillCopy[],
  parked: readonly ProjectSkillParkedView[],
): ProjectSkillRow["agents"][ProjectSkillHarness] {
  const copy = members.find((member) => member.harnessId === harnessId);
  const park = parked.find((item) => item.harnessId === harnessId);
  if (park)
    return {
      state: "disabled",
      folderPath: park.folderPath,
      ...(park.row.agents[harnessId].symlink ? { symlink: true } : {}),
    };
  return copy
    ? { state: "installed", folderPath: copy.folderPath, ...(copy.symlink ? { symlink: true } : {}) }
    : { state: "absent" };
}
function projectSkillRow(
  id: string,
  members: readonly ProjectSkillCopy[],
  parked: readonly ProjectSkillParkedView[],
): ProjectSkillRow {
  const disabled = parked.filter((item) => item.rowId === id);
  const saved = disabled[0]?.row;
  const primary = members.find((member) => member.use) ?? members[0];
  return {
    id,
    ...(primary?.use ? { skillId: primary.use.skillId } : saved?.skillId ? { skillId: saved.skillId } : {}),
    name: primary?.name ?? saved!.name,
    description: primary?.description ?? saved!.description,
    origin: primary?.origin ?? saved!.origin,
    state: aggregateState(members),
    agents: {
      "claude-code": agentState("claude-code", members, disabled),
      codex: agentState("codex", members, disabled),
    },
  };
}

export function buildProjectSkillsView(
  copies: readonly ProjectSkillCopy[],
  parked: readonly ProjectSkillParkedView[],
): Pick<ProjectSkills, "skills" | "activeSkillCount" | "startupCost"> {
  const groups = new Map<string, ProjectSkillCopy[]>();
  for (const copy of copies) {
    const matchingManaged = copies.find(
      (other) => other.use && folderName(other.folderPath) === folderName(copy.folderPath),
    );
    const id =
      copy.use?.skillId ??
      matchingManaged?.use?.skillId ??
      parked.find((item) => folderName(item.folderPath) === folderName(copy.folderPath))?.rowId ??
      `project-skill:${folderName(copy.folderPath)}`;
    groups.set(id, [...(groups.get(id) ?? []), copy]);
  }
  for (const record of parked) if (!groups.has(record.rowId)) groups.set(record.rowId, []);
  const skills = [...groups]
    .map(([id, members]) => projectSkillRow(id, members, parked))
    .sort((left, right) => left.name.localeCompare(right.name));
  const activeSkillCount = { "claude-code": 0, codex: 0 };
  const startupCost = { "claude-code": 0, codex: 0 };
  for (const harnessId of harnesses) {
    const active = skills.filter((row) => row.agents[harnessId].state === "installed");
    activeSkillCount[harnessId] = active.length;
    startupCost[harnessId] = Math.ceil(
      active.reduce((total, row) => {
        const copy = groups.get(row.id)!.find((member) => member.harnessId === harnessId)!;
        return total + copy.name.length + copy.description.length;
      }, 0) / 4,
    );
  }
  return { skills, activeSkillCount, startupCost };
}
