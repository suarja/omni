import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationReceipt } from "../shared/operations-ipc";
import type { AgentRestoreResult, AgentRestoreAction } from "./operations-install-agents-restore";
import { hashContent } from "./marketplace-manifests";
import { isMissing, readOptionalText } from "./fs-optional";
import { codexSection, readClaudeMcpEntryRaw, setClaudeMcpEntryRaw, setCodexSectionRaw } from "./mcp-entry";
import { readGuardEntry, setGuardEntry } from "./hook-entry";
import { readRegularFile } from "./operation-files";
import { planExactAgentSettingsRestore } from "./agent-settings-restore";

export async function planDisconnectedAgentRestore(
  receipt: OperationReceipt,
  homeDir: string,
  backupRoot: string,
): Promise<AgentRestoreResult> {
  const actions: AgentRestoreAction[] = [];
  try {
    for (const directory of receipt.actions
      .filter((action) => action.kind === "delete-directory")
      .sort((left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length)) {
      const path = join(homeDir, directory.relativePath);
      const exists = await lstat(path)
        .then(() => true)
        .catch((error: unknown) => (isMissing(error) ? false : Promise.reject(error)));
      if (exists)
        return {
          status: "blocked",
          reason: "restore-drift",
          diagnostic: "An Omni skill directory was recreated after disconnection. Keep it before restoring.",
        };
      actions.push({ kind: "create-directory", relativePath: directory.relativePath, absolutePath: path });
    }
    for (const file of receipt.files ?? []) {
      if (await readRegularFile(homeDir, file.relativePath))
        return {
          status: "blocked",
          reason: "restore-drift",
          diagnostic: "An Omni skill was recreated after disconnection. Keep it before restoring.",
        };
      const content = await readFile(join(backupRoot, file.relativePath), "utf8");
      if (hashContent(content) !== file.previousHash) throw new Error("The disconnection backup changed.");
      actions.push({
        kind: "write-file",
        relativePath: file.relativePath,
        absolutePath: join(homeDir, file.relativePath),
        byteLength: Buffer.byteLength(content),
        content,
      });
    }
    for (const manifest of receipt.manifests ?? []) {
      const path = manifest.relativePath.replace(/^~\//u, "");
      const exact = await planExactAgentSettingsRestore(homeDir, backupRoot, path, manifest);
      if (exact) {
        actions.push(exact);
        continue;
      }
      const before = await readFile(join(backupRoot, path), "utf8");
      if (hashContent(before) !== manifest.beforeHash) throw new Error("The disconnection backup changed.");
      const current = await readOptionalText(join(homeDir, path));
      const guard = path.endsWith("settings.json") || path.endsWith("hooks.json");
      const existing = guard
        ? readGuardEntry(current)
        : path === ".claude.json"
          ? readClaudeMcpEntryRaw(current)
          : current === undefined
            ? undefined
            : codexSection(current).section;
      if (existing !== undefined)
        return {
          status: "blocked",
          reason: "restore-drift",
          diagnostic: "Omni was reconnected after disconnection. Keep the current connection before restoring.",
        };
      const content = guard
        ? setGuardEntry(current, readGuardEntry(before))
        : path === ".claude.json"
          ? setClaudeMcpEntryRaw(current, readClaudeMcpEntryRaw(before))
          : setCodexSectionRaw(current, codexSection(before).section);
      if (content === undefined) throw new Error("The disconnected entry is missing from its backup.");
      actions.push({
        kind: "write-file",
        relativePath: path,
        absolutePath: join(homeDir, path),
        manifest: true,
        ...(current === undefined ? {} : { beforeHash: hashContent(current) }),
        byteLength: Buffer.byteLength(content),
        content,
      });
    }
    return { status: "ready", actions };
  } catch {
    return {
      status: "blocked",
      reason: "restore-backup-missing",
      diagnostic: "The disconnection backup is unavailable or changed.",
    };
  }
}
