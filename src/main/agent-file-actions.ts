import { lstat, readFile, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentFileAction } from "./agent-file-operation";
import { hashContent } from "./marketplace-manifests";
import {
  ensureDirectories,
  readRegularFile,
  removeFileOrEmptyDirectories,
  safePath,
  writeAtomically,
} from "./operation-files";

export async function verifyAgentFile(home: string, action: AgentFileAction): Promise<void> {
  if (action.kind === "create-directory") return;
  if (action.kind === "delete-directory") {
    const stat = await lstat(await safePath(home, action.relativePath));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`The approved agent directory ${action.relativePath} changed. Inspect it before retrying.`);
    return;
  }
  const current = await readRegularFile(home, action.relativePath);
  if (action.beforeHash ? !current || hashContent(current) !== action.beforeHash : current !== undefined)
    throw new Error(`The approved agent file ${action.relativePath} changed. Inspect it, then retry from Settings.`);
}

export async function applyAgentFile(home: string, action: AgentFileAction): Promise<void> {
  await verifyAgentFile(home, action);
  if (action.kind === "create-directory") await ensureDirectories(home, action.relativePath);
  else if (action.kind === "delete-directory") await rmdir(await safePath(home, action.relativePath));
  else if (action.kind === "write-file") await writeAtomically(home, action.relativePath, action.content ?? "");
  else await removeFileOrEmptyDirectories(home, action.relativePath, dirname(action.relativePath));
}

export async function verifyWrittenAgentFile(home: string, action: AgentFileAction): Promise<void> {
  if (action.kind !== "write-file") return;
  const current = await readRegularFile(home, action.relativePath);
  if (!current || hashContent(current) !== hashContent(action.content ?? ""))
    throw new Error(`The written agent file ${action.relativePath} could not be verified. Inspect it from Settings.`);
}

export async function rollBackAgentFiles(
  home: string,
  backupRoot: string,
  completed: readonly AgentFileAction[],
): Promise<Readonly<{ restored: ReadonlySet<AgentFileAction>; errors: readonly string[] }>> {
  const restored = new Set<AgentFileAction>();
  const errors: string[] = [];
  for (const action of [...completed].reverse()) {
    if (action.kind === "create-directory") {
      restored.add(action);
      continue;
    }
    try {
      if (action.kind === "delete-directory") {
        await ensureDirectories(home, action.relativePath);
        restored.add(action);
        continue;
      }
      const current = await readRegularFile(home, action.relativePath);
      const unchanged =
        action.kind === "delete-file"
          ? current === undefined
          : current !== undefined && hashContent(current) === hashContent(action.content ?? "");
      if (!unchanged) throw new Error("the file changed after Omni wrote it");
      if (action.beforeHash) {
        const backup = await readFile(join(backupRoot, action.relativePath));
        if (hashContent(backup) !== action.beforeHash) throw new Error("the backup does not match the approved file");
        await writeAtomically(home, action.relativePath, backup);
      } else await removeFileOrEmptyDirectories(home, action.relativePath, dirname(action.relativePath));
      restored.add(action);
    } catch (error: unknown) {
      errors.push(`${action.relativePath}: ${error instanceof Error ? error.message : "restoration failed"}`);
    }
  }
  return { restored, errors };
}
