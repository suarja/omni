import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OperationReceipt } from "../shared/operations-ipc";
import type { AgentHarnessInspection } from "./agent-harnesses";
import { harnessPaths } from "./agent-harnesses";
import type { AgentFileAction } from "./agent-file-operation";
import { hashContent } from "./marketplace-manifests";
import { isMissing } from "./fs-optional";
import { safePath } from "./operation-files";

function matchesInstalledBytes(
  skill: AgentHarnessInspection["skillDetails"][number],
  root: string,
  receipts: readonly OperationReceipt[],
): boolean {
  if (skill.state === "installed" || skill.state === "missing") return true;
  if (skill.state === "foreign") return false;
  return [...skill.contents].every(([path, content]) => {
    const relativePath = `${root}/${path}`;
    const installed = receipts.find(
      (receipt) =>
        receipt.kind === "install-agents" &&
        receipt.status === "applied" &&
        !receipt.restored &&
        receipt.files?.some((file) => file.relativePath === relativePath),
    );
    return installed?.files?.find((file) => file.relativePath === relativePath)?.contentHash === hashContent(content);
  });
}

async function removableSkillDirectories(homeDir: string, relativePath: string): Promise<AgentFileAction[]> {
  const path = await safePath(homeDir, relativePath);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  const children: AgentFileAction[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new Error(`The agent skill ${relativePath} contains a symlink. Inspect it before disconnecting.`);
    if (entry.isDirectory())
      children.push(...(await removableSkillDirectories(homeDir, `${relativePath}/${entry.name}`)));
  }
  return [...children, { kind: "delete-directory", relativePath, absolutePath: path }];
}

/** Only supplied Omni bytes are removed; an edited skill stays intact, as a whole. */
export async function planAgentSkillRemovals(
  agent: AgentHarnessInspection,
  receipts: readonly OperationReceipt[],
  homeDir: string,
): Promise<readonly AgentFileAction[]> {
  const actions: AgentFileAction[] = [];
  for (const skill of agent.skillDetails) {
    const root = `${harnessPaths(agent.harness).skills}/${skill.name}`;
    if (!matchesInstalledBytes(skill, root, receipts)) continue;
    for (const [path, content] of skill.contents) {
      const relativePath = `${root}/${path}`;
      actions.push({
        kind: "delete-file",
        relativePath,
        absolutePath: join(homeDir, relativePath),
        beforeHash: hashContent(content),
        beforeContent: content,
      });
    }
    actions.push(...(await removableSkillDirectories(homeDir, root)));
  }
  return actions;
}
