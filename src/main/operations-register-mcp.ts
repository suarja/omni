import { agentHomeDir } from "./agent-harnesses";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createUnifiedDiff } from "../domain/unified-diff";

import type { AgentHarness } from "../shared/agents-ipc";
import type {
  ApplyOperationResponse,
  OperationAction,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest } from "../shared/operations-ipc";
import {
  parseRegisterMcpRequest,
  type RegisterMcpAction,
  type RegisterMcpRequest,
} from "../shared/operations-register-mcp-ipc";
import { createOperationStore, type OperationStore } from "./operation-store";
import {
  backupFiles,
  readRegularFile,
  removeFileOrEmptyDirectories,
  restoreBackup,
  writeAtomically,
} from "./operation-files";
import { harnessPaths, mcpCliPath } from "./agent-harnesses";
import { codexMcpBlock, codexSection, mcpEntry, mcpEntryState, tomlHeaders, type TomlHeader } from "./mcp-entry";
import { readOptionalText } from "./fs-optional";
import { hashContent } from "./marketplace-manifests";

const MCP_BLOCK_REASON = "Build the MCP server first (pnpm --filter @omni/mcp build)";

export type PlannedAction = OperationAction & Readonly<{ absolutePath: string; content: string }>;
type RegisterMcpOptions = Readonly<{
  userDataPath: string;
  operationStore?: OperationStore;
  homeDir?: string;
  cliPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  now?: () => number;
}>;

function viewAction(action: PlannedAction): OperationAction {
  return {
    kind: action.kind,
    relativePath: action.relativePath,
    ...(action.byteLength === undefined ? {} : { byteLength: action.byteLength }),
    ...(action.beforeHash === undefined ? {} : { beforeHash: action.beforeHash }),
    ...(action.diff === undefined ? {} : { diff: action.diff }),
  };
}

function withoutOmni(value: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (copy.mcpServers && typeof copy.mcpServers === "object" && !Array.isArray(copy.mcpServers))
    delete (copy.mcpServers as Record<string, unknown>).omni;
  return copy;
}

function updateClaude(
  before: string | undefined,
  action: RegisterMcpAction,
  path: string,
  userDataPath: string,
): Readonly<{ content?: string; registered: boolean; notes: readonly string[] }> {
  if (before === undefined) {
    if (action === "disable") return { registered: false, notes: ["not registered"] };
    const content = JSON.stringify({ mcpServers: { omni: mcpEntry(path, userDataPath) } }, null, 2);
    return { content, registered: false, notes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    throw new Error("Claude Code settings are not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Claude Code settings must be a JSON object.");
  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers)))
    throw new Error("Claude Code mcpServers must be a JSON object.");
  const registration = mcpEntryState("claude-code", before, path, userDataPath);
  const registered = registration.registered;
  const matches = registration.current;
  if ((action === "enable" && matches) || (action === "disable" && !registered))
    return { registered, notes: [action === "enable" ? "already registered" : "not registered"] };
  const untouched = withoutOmni(root);
  const next = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  const nextServers = (next.mcpServers ??= {}) as Record<string, unknown>;
  if (action === "enable") nextServers.omni = mcpEntry(path, userDataPath);
  else delete nextServers.omni;
  assert.deepEqual(withoutOmni(next), untouched);
  return { content: JSON.stringify(next, null, 2), registered, notes: [] };
}

function mcpHeader(header: TomlHeader): boolean {
  return header.name.startsWith("mcp_servers.");
}

function updateCodex(
  before: string | undefined,
  action: RegisterMcpAction,
  path: string,
  userDataPath: string,
): Readonly<{ content?: string; registered: boolean; notes: readonly string[] }> {
  const block = codexMcpBlock(path, userDataPath);
  if (before === undefined) {
    if (action === "disable") return { registered: false, notes: ["not registered"] };
    return { content: block, registered: false, notes: [] };
  }
  const existing = codexSection(before);
  const registration = mcpEntryState("codex", before, path, userDataPath);
  const registered = registration.registered;
  const matches = registration.current;
  if ((action === "enable" && matches) || (action === "disable" && !registered))
    return { registered, notes: [action === "enable" ? "already registered" : "not registered"] };
  if (action === "disable")
    return { content: before.slice(0, existing.start) + before.slice(existing.end), registered, notes: [] };
  if (existing.start !== undefined)
    return { content: before.slice(0, existing.start) + block + before.slice(existing.end), registered, notes: [] };
  const headers = tomlHeaders(before);
  const lastMcp = headers.filter(mcpHeader).at(-1);
  const insertion = lastMcp ? (headers[headers.indexOf(lastMcp) + 1]?.start ?? before.length) : before.length;
  const prefix = before.slice(0, insertion);
  const separator = !prefix ? "" : prefix.endsWith("\n\n") ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
  // Keep the file's rhythm: one blank line between the new table and the table that follows it.
  const rest = before.slice(insertion);
  const trailing = rest && !rest.startsWith("\n") ? "\n" : "";
  return { content: `${prefix}${separator}${block}${trailing}${rest}`, registered, notes: [] };
}

export function unifiedDiff(before: string | undefined, after: string, display: string): string | undefined {
  if (before === after) return undefined;
  return createUnifiedDiff(display, display, before ?? "", after).text;
}

function settingsPath(homeDir: string, relative: string): string {
  return join(homeDir, relative);
}

function buildUpdate(
  request: RegisterMcpRequest,
  before: string | undefined,
  cli: string,
  userDataPath: string,
): Readonly<{ content?: string; registered: boolean; notes: readonly string[] }> {
  return request.harness === "claude-code"
    ? updateClaude(before, request.action, cli, userDataPath)
    : updateCodex(before, request.action, cli, userDataPath);
}

export type RegisterMcpPlan = Readonly<{
  action?: PlannedAction;
  relativePath: string;
  displayTarget: string;
  registered: boolean;
  notes: readonly string[];
}>;

export function planRegisterMcp(
  input: Readonly<{
    harness: "claude-code" | "codex";
    action: RegisterMcpAction;
    homeDir: string;
    cliPath: string;
    userDataPath: string;
    before?: string;
  }>,
): RegisterMcpPlan {
  const target = harnessPaths(input.harness);
  const update = buildUpdate(
    { kind: "register-mcp", harness: input.harness, action: input.action },
    input.before,
    input.cliPath,
    input.userDataPath,
  );
  const action =
    update.content === undefined
      ? undefined
      : {
          kind: "write-file" as const,
          relativePath: target.settings,
          byteLength: Buffer.byteLength(update.content),
          ...(input.before === undefined ? {} : { beforeHash: hashContent(input.before) }),
          diff: unifiedDiff(input.before, update.content, target.settingsDisplay),
          absolutePath: settingsPath(input.homeDir, target.settings),
          content: update.content,
        };
  return {
    ...(action ? { action } : {}),
    relativePath: target.settings,
    displayTarget: target.settingsDisplay,
    registered: update.registered,
    notes: update.notes,
  };
}

export function createRegisterMcpOperations(options: RegisterMcpOptions): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const home = agentHomeDir(options);
  const store = options.operationStore ?? createOperationStore(join(options.userDataPath, "omni", "operations.json"));
  const now = options.now ?? Date.now;
  const plans = new Map<
    string,
    Readonly<{
      plan: OperationPlan;
      operationId: string;
      request: RegisterMcpRequest;
      action?: PlannedAction;
      relativePath: string;
      cliPath: string;
    }>
  >();
  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parseRegisterMcpRequest(raw);
    const target = harnessPaths(request.harness);
    const cli = mcpCliPath(options);
    try {
      await readFile(cli);
    } catch {
      return { status: "blocked", reason: "mcp-build-missing", diagnostic: MCP_BLOCK_REASON };
    }
    const before = await readOptionalText(settingsPath(home, target.settings));
    let planned: RegisterMcpPlan;
    try {
      planned = planRegisterMcp({
        harness: request.harness,
        action: request.action,
        homeDir: home,
        cliPath: cli,
        userDataPath: options.userDataPath,
        ...(before === undefined ? {} : { before }),
      });
    } catch (error: unknown) {
      return {
        status: "blocked",
        reason: "settings-invalid",
        diagnostic: error instanceof Error ? error.message : "Settings could not be read safely.",
      };
    }
    if (request.action === "enable" && !before && !planned.action)
      return { status: "blocked", reason: "settings-invalid", diagnostic: "The settings update could not be planned." };
    const planId = randomUUID();
    const action = planned.action;
    const plan: OperationPlan = {
      planId,
      kind: "register-mcp",
      displayTarget: target.settingsDisplay,
      actions: action ? [viewAction(action)] : [],
      git: { mode: "not-a-repository", warnings: [] },
      ...(planned.notes.length ? { notes: planned.notes } : {}),
    };
    plans.set(planId, {
      plan,
      operationId: randomUUID(),
      request,
      ...(action ? { action } : {}),
      relativePath: target.settings,
      cliPath: cli,
    });
    return { status: "ready", plan };
  };
  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored || !stored.action) return undefined;
    plans.delete(request.planId);
    const backupRoot = join(options.userDataPath, "omni", "backups", stored.operationId);
    const action = stored.action;
    try {
      if (action.beforeHash) await backupFiles(home, backupRoot, [stored.relativePath]);
      const current = await readRegularFile(home, stored.relativePath);
      if (action.beforeHash && (!current || hashContent(current) !== action.beforeHash))
        throw new Error("The approved settings file changed.");
      if (!action.beforeHash && current) throw new Error("The approved settings destination already exists.");
      await writeAtomically(home, stored.relativePath, action.content);
      const written = await readRegularFile(home, stored.relativePath);
      if (!written || hashContent(written) !== hashContent(action.content))
        throw new Error("The written settings file could not be verified.");
      const receipt: OperationReceipt = {
        operationId: stored.operationId,
        kind: "register-mcp",
        status: "applied",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        actions: [{ ...viewAction(action), status: "applied" }],
        git: { mode: "not-a-repository" },
        registered: null,
        manifests: [
          {
            relativePath: stored.plan.displayTarget,
            ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
            afterHash: hashContent(action.content),
          },
        ],
        harness: stored.request.harness,
        mcpAction: stored.request.action,
        cliPath: stored.cliPath,
      };
      const saved = await store.append(receipt);
      if (saved.status !== "ready") throw new Error("The MCP registration receipt could not be persisted safely.");
      return { status: "applied", receipt };
    } catch (error: unknown) {
      if (action.beforeHash) await restoreBackup(home, backupRoot, stored.relativePath).catch(() => false);
      else await removeFileOrEmptyDirectories(home, stored.relativePath, ".").catch(() => undefined);
      const receipt: OperationReceipt = {
        operationId: stored.operationId,
        kind: "register-mcp",
        status: "failed",
        appliedAt: new Date(now()).toISOString(),
        displayTarget: stored.plan.displayTarget,
        actions: [{ ...viewAction(action), status: "failed" }],
        git: { mode: "not-a-repository" },
        registered: null,
        harness: stored.request.harness,
        mcpAction: stored.request.action,
        cliPath: stored.cliPath,
        diagnostic: error instanceof Error ? error.message : "The MCP registration failed.",
      };
      await store.append(receipt).catch(() => undefined);
      return { status: "failed", receipt };
    }
  };
  return { preview, apply };
}
