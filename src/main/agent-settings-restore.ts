import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationReceipt } from "../shared/operations-ipc";
import type { AgentRestoreAction } from "./operations-install-agents-restore";
import { hashContent } from "./marketplace-manifests";
import { readRegularFile } from "./operation-files";

/** Exact reversal is safe only while the file still contains the operation's written bytes. */
export async function planExactAgentSettingsRestore(
  homeDir: string,
  backupRoot: string,
  relativePath: string,
  manifest: NonNullable<OperationReceipt["manifests"]>[number],
): Promise<AgentRestoreAction | undefined> {
  const current = await readRegularFile(homeDir, relativePath);
  if (current === undefined || hashContent(current) !== manifest.afterHash) return undefined;
  if (manifest.beforeHash === undefined)
    return { kind: "delete-file", relativePath, absolutePath: join(homeDir, relativePath), manifest: true };
  const content = await readFile(join(backupRoot, relativePath), "utf8");
  if (hashContent(content) !== manifest.beforeHash)
    throw new Error(`The agent settings backup for ${relativePath} changed. Preserve it before restoring.`);
  return {
    kind: "write-file",
    relativePath,
    absolutePath: join(homeDir, relativePath),
    manifest: true,
    beforeHash: manifest.afterHash,
    byteLength: Buffer.byteLength(content),
    content,
  };
}
