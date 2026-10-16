import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentHarness } from "../shared/agents-ipc";
import type { OperationAction, OperationReceipt } from "../shared/operations-ipc";
import { guardScriptPath, harnessLabel, harnessPaths } from "./agent-harnesses";
import { isMissing, readOptionalText } from "./fs-optional";
import { hashContent } from "./marketplace-manifests";
import {
  codexSection,
  mcpEntryState,
  readClaudeMcpEntryRaw,
  setClaudeMcpEntryRaw,
  setCodexSectionRaw,
  type McpEntryState,
} from "./mcp-entry";
import { guardEntryState, readGuardEntry, setGuardEntry, type GuardHookEntry } from "./hook-entry";
import { planRegisterMcp } from "./operations-register-mcp";
import { planExactAgentSettingsRestore } from "./agent-settings-restore";

export type AgentRestoreAction = OperationAction & Readonly<{ absolutePath: string; content?: string }>;
export type AgentRestoreResult =
  | Readonly<{ status: "ready"; actions: readonly AgentRestoreAction[]; notes?: readonly string[] }>
  | Readonly<{ status: "blocked"; reason: string; diagnostic: string }>;

type SettingsManifest = NonNullable<OperationReceipt["manifests"]>[number];
type SettingsRemovalResult =
  | Readonly<{ status: "ready"; action?: AgentRestoreAction; notes: readonly string[] }>
  | Readonly<{ status: "blocked"; reason: string; diagnostic: string }>;

// Kept byte-for-byte compatible with its previous signature and return shape: `operations-
// restore.ts` (owned by another stream) calls this directly for standalone `register-mcp`
// restores and is off-limits here. It only ever removes the MCP entry entirely — a standalone
// register-mcp operation has no "updated an existing entry" install-agents backup to restore
// from, so there is nothing to generalize for this call site.
export async function settingsRemovalAction(
  harness: AgentHarness,
  homeDir: string,
  cliPath: string,
  userDataPath: string,
  manifest: SettingsManifest,
): Promise<SettingsRemovalResult> {
  const paths = harnessPaths(harness);
  const relativePath = paths.settings;
  const content = await readOptionalText(join(homeDir, relativePath));
  const registration = mcpEntryState(harness, content, cliPath, userDataPath);
  if (!registration.registered) return { status: "ready", notes: ["already removed"] };
  if (!registration.current)
    return {
      status: "blocked",
      reason: "restore-drift",
      diagnostic: `The Omni entry in the ${harnessLabel(harness)} settings was modified after installation; remove it by hand or run the install again.`,
    };
  if (manifest.beforeHash === undefined && content !== undefined && hashContent(content) === manifest.afterHash)
    return {
      status: "ready",
      action: { kind: "delete-file", relativePath, absolutePath: join(homeDir, relativePath), manifest: true },
      notes: [],
    };
  const planned = planRegisterMcp({
    harness,
    action: "disable",
    homeDir,
    cliPath,
    userDataPath,
    ...(content === undefined ? {} : { before: content }),
  });
  return planned.action
    ? { status: "ready", action: { ...planned.action, manifest: true }, notes: [] }
    : { status: "ready", notes: ["already removed"] };
}

// One reverse-edit shape for "an Omni-owned entry in a provider settings file" (item 8),
// parameterised per manifest kind below instead of writing a parallel copy for the guard hook
// and for "restore the previous MCP entry" (the JSON-key one, TOML-block one and JSON-array-item
// one are different grammars, but the algorithm around them — registered/current/drift check,
// delete-whole-file-if-Omni-made-it, else reverse-edit to the previous value or remove — is one
// function, `manifestRemovalAction` below).
type ManifestFormat = Readonly<{
  state: (content: string | undefined) => McpEntryState;
  readRaw: (content: string | undefined) => unknown;
  write: (content: string | undefined, value: unknown) => string | undefined;
}>;

function manifestFormat(
  harness: AgentHarness,
  kind: "mcp" | "guard",
  cliPath: string,
  userDataPath: string,
  guardPath: string,
): ManifestFormat {
  if (kind === "guard")
    return {
      state: (content) => guardEntryState(content, harness, guardPath),
      readRaw: readGuardEntry,
      write: (content, value) => setGuardEntry(content, value as GuardHookEntry | undefined),
    };
  if (harness === "claude-code")
    return {
      state: (content) => mcpEntryState(harness, content, cliPath, userDataPath),
      readRaw: readClaudeMcpEntryRaw,
      write: (content, value) => setClaudeMcpEntryRaw(content, value),
    };
  return {
    state: (content) => mcpEntryState(harness, content, cliPath, userDataPath),
    readRaw: (content) => (content === undefined ? undefined : codexSection(content).section),
    write: (content, value) => setCodexSectionRaw(content, value as string | undefined),
  };
}

function manifestLocation(
  displayPath: string,
): Readonly<{ harness: AgentHarness; kind: "mcp" | "guard"; relativePath: string }> | undefined {
  for (const harness of ["claude-code", "codex"] as const) {
    const paths = harnessPaths(harness);
    if (displayPath === paths.settingsDisplay) return { harness, kind: "mcp", relativePath: paths.settings };
    if (displayPath === paths.guardSettingsDisplay)
      return { harness, kind: "guard", relativePath: paths.guardSettings };
  }
  return undefined;
}

async function manifestRemovalAction(
  format: ManifestFormat,
  harnessName: string,
  homeDir: string,
  backupRoot: string,
  relativePath: string,
  manifest: SettingsManifest,
): Promise<SettingsRemovalResult> {
  const exact = await planExactAgentSettingsRestore(homeDir, backupRoot, relativePath, manifest);
  if (exact) return { status: "ready", action: exact, notes: [] };
  const content = await readOptionalText(join(homeDir, relativePath));
  const state = format.state(content);
  if (!state.registered) return { status: "ready", notes: ["already removed"] };
  if (content === undefined) return { status: "ready", notes: ["already removed"] };
  if (!state.current)
    return {
      status: "blocked",
      reason: "restore-drift",
      diagnostic: `The Omni entry in the ${harnessName} settings was modified after installation; remove it by hand or run the install again.`,
    };
  if (manifest.beforeHash === undefined && hashContent(content) === manifest.afterHash)
    return {
      status: "ready",
      action: { kind: "delete-file", relativePath, absolutePath: join(homeDir, relativePath), manifest: true },
      notes: [],
    };
  let previousRaw: unknown;
  if (manifest.beforeHash !== undefined) {
    try {
      previousRaw = format.readRaw(await readFile(join(backupRoot, relativePath), "utf8"));
    } catch {
      previousRaw = undefined;
    }
  }
  const nextContent = format.write(content, previousRaw);
  if (nextContent === undefined || nextContent === content) return { status: "ready", notes: ["already removed"] };
  return {
    status: "ready",
    action: {
      kind: "write-file",
      relativePath,
      byteLength: Buffer.byteLength(nextContent),
      beforeHash: hashContent(content),
      manifest: true,
      absolutePath: join(homeDir, relativePath),
      content: nextContent,
    },
    notes: [],
  };
}

async function currentHash(path: string): Promise<string | undefined> {
  try {
    return hashContent(await readFile(path));
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function skillFile(
  receipt: OperationReceipt,
  relativePath: string,
): NonNullable<OperationReceipt["files"]>[number] | undefined {
  return receipt.files?.find((file) => file.relativePath === relativePath);
}

async function backupContent(backupRoot: string, relativePath: string): Promise<string> {
  return readFile(join(backupRoot, relativePath), "utf8");
}

// Kept byte-for-byte compatible with its previous signature and return shape (see the note on
// `settingsRemovalAction` above).
export async function planInstallAgentsRestore(
  receipt: OperationReceipt,
  homeDir: string,
  backupRoot: string,
  cliPath: string,
  userDataPath: string,
): Promise<AgentRestoreResult> {
  try {
    for (const action of receipt.actions) {
      const file = skillFile(receipt, action.relativePath);
      if (!file) continue;
      const actual = await currentHash(join(homeDir, action.relativePath));
      const deleted = action.kind === "delete-file";
      if ((!deleted && actual !== file.contentHash) || (deleted && actual !== undefined))
        return {
          status: "blocked",
          reason: "restore-drift",
          diagnostic: "An installed agent skill file changed; restore is blocked.",
        };
    }
    const guardPath = guardScriptPath({ userDataPath });
    const actions: AgentRestoreAction[] = [];
    const notes: string[] = [];
    for (const manifest of receipt.manifests ?? []) {
      const location = manifestLocation(manifest.relativePath);
      if (!location) continue;
      const format = manifestFormat(location.harness, location.kind, cliPath, userDataPath, guardPath);
      const removed = await manifestRemovalAction(
        format,
        harnessLabel(location.harness),
        homeDir,
        backupRoot,
        location.relativePath,
        manifest,
      );
      if (removed.status === "blocked") return removed;
      if (removed.action) actions.push(removed.action);
      notes.push(...removed.notes);
    }
    for (const original of receipt.actions) {
      const file = skillFile(receipt, original.relativePath);
      if (!file) continue;
      if (original.kind === "delete-file" || file.previousHash) {
        const content = await backupContent(backupRoot, original.relativePath);
        actions.push({
          kind: "write-file",
          relativePath: original.relativePath,
          byteLength: Buffer.byteLength(content),
          absolutePath: join(homeDir, original.relativePath),
          content,
        });
      } else {
        actions.push({
          kind: "delete-file",
          relativePath: original.relativePath,
          absolutePath: join(homeDir, original.relativePath),
        });
      }
    }
    const created =
      receipt.createdDirectories ??
      receipt.actions.filter((action) => action.kind === "create-directory").map((action) => action.relativePath);
    actions.push(
      ...[...created]
        .sort((left, right) => right.split("/").length - left.split("/").length)
        .map((relativePath) => ({
          kind: "delete-directory" as const,
          relativePath,
          absolutePath: join(homeDir, relativePath),
        })),
    );
    return { status: "ready", actions, ...(notes.length ? { notes } : {}) };
  } catch {
    return {
      status: "blocked",
      reason: "restore-backup-missing",
      diagnostic: "The pre-installation agent backup is unavailable.",
    };
  }
}
