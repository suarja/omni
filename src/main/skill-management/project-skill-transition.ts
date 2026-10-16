import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ProjectSkillHarness, ProjectSkillIntent, ProjectSkillRow } from "../../shared/project-skills-ipc";
import { parseSkillLocationKey } from "../../domain/skill-reconciliation/validation";
import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { RegistryGrant } from "../registry-ipc";
import type { ProjectSkillDependencies } from "./project-skill-plan";
import type { ParkedProjectSkill } from "./project-skill-parking";
import { captureExactSkillTree, hashExactTree, type ExactSkillTree } from "./project-skill-files";

export type ProjectSkillTransition = Readonly<{
  location: SkillLocationKey;
  local?: ExactSkillTree;
  nextLocal?: ExactSkillTree;
  park?: ParkedProjectSkill;
  nextPark?: ParkedProjectSkill;
  parkedTree?: ExactSkillTree;
  nextParkTree?: ExactSkillTree;
  readChecks?: readonly Readonly<{ folderPath: string; hash: string }>[];
}>;
async function copyPeerSkill(
  grant: RegistryGrant,
  peerPath: string,
  targetPath: string,
): Promise<{ tree: ExactSkillTree; hash: string }> {
  const tree = await captureExactSkillTree(grant.root, peerPath);
  if (!tree) throw new Error("The peer skill disappeared; refresh the project.");
  const hash = hashExactTree(tree)!;
  if (tree[0]?.kind !== "symlink") return { tree, hash };
  const target = await realpath(resolve(grant.root, dirname(peerPath), tree[0].target));
  const within = relative(grant.root, target);
  if (!within || within.startsWith("../") || within === ".." || target === join(grant.root, targetPath))
    throw new Error("The peer link does not have a safe distinct target inside the project.");
  return { tree: [{ ...tree[0], target: relative(join(grant.root, dirname(targetPath)), target) }], hash };
}

async function resolveTransition(
  intent: ProjectSkillIntent,
  row: ProjectSkillRow,
  before: ProjectSkillTransition,
  grant: RegistryGrant,
  hasMetadata: boolean,
): Promise<ProjectSkillTransition | undefined> {
  const { local, park, parkedTree, location } = before;
  if (intent.action === "disable" || intent.action === "remove-agent") {
    if (park || !local) return undefined;
    return {
      ...before,
      nextPark: {
        projectId: intent.projectId,
        rowId: row.id,
        harnessId: location.harnessId as ProjectSkillHarness,
        folderPath: location.folderPath,
        row,
        contentPath: `omni/parked/${randomUUID()}/content`,
      },
      nextParkTree: local,
    };
  }
  if (intent.action === "enable") return park ? { ...before, nextLocal: parkedTree } : undefined;
  if (intent.action === "delete") return park || local || hasMetadata ? before : undefined;
  if (park) return { ...before, nextLocal: parkedTree };
  if (local) {
    if (row.agents[location.harnessId as ProjectSkillHarness].state !== "installed")
      throw new Error("The agent's skill location is occupied; no content was overwritten.");
    return undefined;
  }
  const peer = Object.entries(row.agents).find(
    ([id, item]) => id !== location.harnessId && item.state === "installed",
  )?.[1];
  if (!peer?.folderPath) throw new Error("No installed peer copy is available for this agent.");
  const copy = await copyPeerSkill(grant, peer.folderPath, location.folderPath);
  return { ...before, nextLocal: copy.tree, readChecks: [{ folderPath: peer.folderPath, hash: copy.hash }] };
}

export async function readProjectSkillTransition(
  intent: ProjectSkillIntent,
  row: ProjectSkillRow,
  harnessId: ProjectSkillHarness,
  grant: RegistryGrant,
  parked: readonly ParkedProjectSkill[],
  args: ProjectSkillDependencies,
  hasMetadata: (location: SkillLocationKey) => boolean,
): Promise<ProjectSkillTransition | undefined> {
  const park = parked.find(
    (item) => item.projectId === intent.projectId && item.rowId === row.id && item.harnessId === harnessId,
  );
  const knownPath =
    row.agents[harnessId].folderPath ?? row.agents.codex.folderPath ?? row.agents["claude-code"].folderPath;
  const folderPath =
    row.agents[harnessId].folderPath ??
    `${harnessId === "codex" ? ".agents" : ".claude"}/skills/${basename(knownPath ?? row.name)}`;
  const location = parseSkillLocationKey({ projectId: intent.projectId, harnessId, folderPath });
  const local = await captureExactSkillTree(grant.root, folderPath);
  const parkedTree = park && (await captureExactSkillTree(args.userDataPath, park.contentPath));
  if (park && !parkedTree) throw new Error("The parked skill content is unavailable; inspect its receipt.");
  if (park && local) throw new Error(`The ${harnessId} skill location is occupied; its replacement is retained.`);
  return resolveTransition(intent, row, { location, local, park, parkedTree }, grant, hasMetadata(location));
}
