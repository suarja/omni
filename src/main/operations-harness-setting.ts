import { agentHomeDir } from "./agent-harnesses";
// D6 (worktree hygiene): a previewed operation that edits one key of Claude Code's own
// `~/.claude/settings.json` — `cleanupPeriodDays`, the number of days after which Claude Code
// removes sub-agent and background-session worktrees on its own. Same grammar as
// `operations-register-mcp.ts` (preview → diff → confirm → write, backup, receipt, restore by
// reverse edit) and the same key-preserving JSON edit approach as its `updateClaude`: parse,
// clone, touch only the one key, re-serialise — everything else in the file passes through
// unchanged. `unifiedDiff` is imported from that module rather than re-implemented.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  ApplyOperationResponse,
  OperationAction,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest } from "../shared/operations-ipc";
import {
  parseWriteHarnessSettingRequest,
  type WriteHarnessSettingRequest,
} from "../shared/operations-harness-setting-ipc";
import { createOperationStore, type OperationStore } from "./operation-store";
import {
  backupFiles,
  readRegularFile,
  removeFileOrEmptyDirectories,
  restoreBackup,
  writeAtomically,
} from "./operation-files";
import { readOptionalText } from "./fs-optional";
import { hashContent } from "./marketplace-manifests";
import { unifiedDiff } from "./operations-register-mcp";

export const HARNESS_SETTING_RELATIVE_PATH = join(".claude", "settings.json");
export const HARNESS_SETTING_DISPLAY = "~/.claude/settings.json";

type PlannedAction = OperationAction & Readonly<{ absolutePath: string; content: string }>;
// The looser shape `operations-restore.ts` uses for every restore branch (a delete action has
// no `content`): exported so `settingsRestorePlan` below can serve both the register-mcp and
// write-harness-setting restore branches without operations-restore.ts growing past its own
// line-count target for what both branches already had to do identically.
export type SettingsRestoreAction = OperationAction & Readonly<{ absolutePath: string; content?: string }>;
type HarnessSettingOptions = Readonly<{
  isPackaged?: boolean;
  userDataPath: string;
  operationStore?: OperationStore;
  homeDir?: string;
  now?: () => number;
}>;

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function parseSettings(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Claude Code settings are not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Claude Code settings must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function currentKeyValue(before: string | undefined, key: string): number | null {
  if (before === undefined) return null;
  const value = parseSettings(before)[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// The same clone-mutate-reserialise shape as `operations-register-mcp.ts`'s `updateClaude`,
// scoped to a single top-level key instead of the nested `mcpServers.omni` entry: every other
// key keeps its value and its position in the file.
export function editJsonKey(
  before: string | undefined,
  key: string,
  value: number | null,
): Readonly<{ content: string }> {
  const root = before === undefined ? {} : parseSettings(before);
  const untouched = withoutKey(root, key);
  const next: Record<string, unknown> = { ...root };
  if (value === null) delete next[key];
  else next[key] = value;
  assert.deepEqual(withoutKey(next, key), untouched);
  return { content: JSON.stringify(next, null, 2) };
}

function settingsPath(homeDir: string): string {
  return join(homeDir, HARNESS_SETTING_RELATIVE_PATH);
}

function viewAction(action: PlannedAction): OperationAction {
  return {
    kind: action.kind,
    relativePath: action.relativePath,
    ...(action.byteLength === undefined ? {} : { byteLength: action.byteLength }),
    ...(action.beforeHash === undefined ? {} : { beforeHash: action.beforeHash }),
    ...(action.diff === undefined ? {} : { diff: action.diff }),
  };
}

function receiptFor(
  operationId: string,
  request: WriteHarnessSettingRequest,
  previousValue: number | null,
  status: "applied" | "failed",
  displayTarget: string,
  actions: OperationReceipt["actions"],
  now: () => number,
  manifest?: NonNullable<OperationReceipt["manifests"]>[number],
  diagnostic?: string,
): OperationReceipt {
  return {
    operationId,
    kind: "write-harness-setting",
    status,
    appliedAt: new Date(now()).toISOString(),
    displayTarget,
    actions,
    git: { mode: "not-a-repository" },
    registered: null,
    ...(manifest ? { manifests: [manifest] } : {}),
    harnessSetting: { harness: request.harness, key: request.key, value: request.value, previousValue },
    ...(diagnostic ? { diagnostic } : {}),
  };
}

// The preview/apply pair a `write-harness-setting` operation needs: mirrors
// `createRegisterMcpOperations` (same backup → verify → write → verify shape) with a
// single-key edit in place of the mcpServers.omni merge.
export function createHarnessSettingOperations(options: HarnessSettingOptions): Readonly<{
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
      request: WriteHarnessSettingRequest;
      action?: PlannedAction;
      previousValue: number | null;
    }>
  >();

  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parseWriteHarnessSettingRequest(raw);
    const before = await readOptionalText(settingsPath(home));
    let current: number | null;
    let content: string | undefined;
    try {
      current = currentKeyValue(before, request.key);
      if (current !== request.value) ({ content } = editJsonKey(before, request.key, request.value));
    } catch (error: unknown) {
      return {
        status: "blocked",
        reason: "settings-invalid",
        diagnostic: error instanceof Error ? error.message : "Settings could not be read safely.",
      };
    }
    const action: PlannedAction | undefined =
      content === undefined
        ? undefined
        : {
            kind: "write-file",
            relativePath: HARNESS_SETTING_RELATIVE_PATH,
            byteLength: Buffer.byteLength(content),
            ...(before === undefined ? {} : { beforeHash: hashContent(before) }),
            diff: unifiedDiff(before, content, HARNESS_SETTING_DISPLAY),
            absolutePath: settingsPath(home),
            content,
          };
    const planId = randomUUID();
    const plan: OperationPlan = {
      planId,
      kind: "write-harness-setting",
      displayTarget: HARNESS_SETTING_DISPLAY,
      actions: action ? [viewAction(action)] : [],
      git: { mode: "not-a-repository", warnings: [] },
      ...(action ? {} : { notes: ["unchanged"] }),
    };
    plans.set(planId, {
      plan,
      operationId: randomUUID(),
      request,
      ...(action ? { action } : {}),
      previousValue: current,
    });
    return { status: "ready", plan };
  };

  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored) return undefined;
    plans.delete(request.planId);
    if (!stored.action) {
      const receipt = receiptFor(
        stored.operationId,
        stored.request,
        stored.previousValue,
        "applied",
        stored.plan.displayTarget,
        [],
        now,
      );
      const saved = await store.append(receipt);
      if (saved.status !== "ready") throw new Error("The setting receipt could not be persisted safely.");
      return { status: "applied", receipt };
    }
    const backupRoot = join(options.userDataPath, "omni", "backups", stored.operationId);
    const action = stored.action;
    try {
      if (action.beforeHash) await backupFiles(home, backupRoot, [action.relativePath]);
      const current = await readRegularFile(home, action.relativePath);
      if (action.beforeHash && (!current || hashContent(current) !== action.beforeHash))
        throw new Error("The approved settings file changed.");
      if (!action.beforeHash && current) throw new Error("The approved settings destination already exists.");
      await writeAtomically(home, action.relativePath, action.content);
      const written = await readRegularFile(home, action.relativePath);
      if (!written || hashContent(written) !== hashContent(action.content))
        throw new Error("The written settings file could not be verified.");
      const receipt = receiptFor(
        stored.operationId,
        stored.request,
        stored.previousValue,
        "applied",
        stored.plan.displayTarget,
        [{ ...viewAction(action), status: "applied" }],
        now,
        {
          relativePath: stored.plan.displayTarget,
          ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
          afterHash: hashContent(action.content),
        },
      );
      const saved = await store.append(receipt);
      if (saved.status !== "ready") throw new Error("The setting receipt could not be persisted safely.");
      return { status: "applied", receipt };
    } catch (error: unknown) {
      if (action.beforeHash) await restoreBackup(home, backupRoot, action.relativePath).catch(() => false);
      else await removeFileOrEmptyDirectories(home, action.relativePath, ".").catch(() => undefined);
      const receipt = receiptFor(
        stored.operationId,
        stored.request,
        stored.previousValue,
        "failed",
        stored.plan.displayTarget,
        [{ ...viewAction(action), status: "failed" }],
        now,
        undefined,
        error instanceof Error ? error.message : "The setting could not be written.",
      );
      await store.append(receipt).catch(() => undefined);
      return { status: "failed", receipt };
    }
  };

  return { preview, apply };
}

// Used by `operations-restore.ts` to compute the reverse edit for a `write-harness-setting`
// receipt: blocked when the key was changed since (by hand, or by Claude Code itself), never
// blocked by unrelated edits elsewhere in the file.
export async function harnessSettingRestoreAction(
  homeDir: string,
  receipt: OperationReceipt,
): Promise<
  | Readonly<{ status: "ready"; action?: PlannedAction; notes: readonly string[] }>
  | Readonly<{ status: "blocked"; reason: string; diagnostic: string }>
> {
  const setting = receipt.harnessSetting;
  if (!setting) {
    return { status: "blocked", reason: "restore-unavailable", diagnostic: "The setting receipt is incomplete." };
  }
  let before: string | undefined;
  let current: number | null;
  try {
    before = await readOptionalText(settingsPath(homeDir));
    current = currentKeyValue(before, setting.key);
  } catch (error: unknown) {
    return {
      status: "blocked",
      reason: "settings-invalid",
      diagnostic: error instanceof Error ? error.message : "Settings could not be read safely.",
    };
  }
  if (current !== setting.value) {
    return {
      status: "blocked",
      reason: "restore-drift",
      diagnostic: `The ${setting.key} setting was changed after Omni wrote it; restore it by hand.`,
    };
  }
  if (current === setting.previousValue) return { status: "ready", notes: ["unchanged"] };
  const { content } = editJsonKey(before, setting.key, setting.previousValue);
  return {
    status: "ready",
    action: {
      kind: "write-file",
      relativePath: HARNESS_SETTING_RELATIVE_PATH,
      byteLength: Buffer.byteLength(content),
      ...(before === undefined ? {} : { beforeHash: hashContent(before) }),
      diff: unifiedDiff(before, content, HARNESS_SETTING_DISPLAY),
      absolutePath: settingsPath(homeDir),
      content,
    },
    notes: [],
  };
}

// Shared by `operations-restore.ts`'s register-mcp and write-harness-setting branches: both
// resolve to at most one settings-file write/delete action, then need the same restore-import
// plan wrapped around it.
export function settingsRestorePlan(
  original: OperationReceipt,
  homeDir: string,
  action: SettingsRestoreAction | undefined,
  notes: readonly string[],
  plans: Map<
    string,
    Readonly<{
      plan: OperationPlan;
      original: OperationReceipt;
      root: string;
      actions: readonly SettingsRestoreAction[];
    }>
  >,
): PreviewMarketplaceResponse {
  const actions: readonly SettingsRestoreAction[] = action ? [action] : [];
  const plan: OperationPlan = {
    planId: randomUUID(),
    kind: "restore-import",
    displayTarget: original.displayTarget,
    actions: actions.map(({ absolutePath: _path, content: _content, ...planAction }) => planAction),
    git: { mode: "not-a-repository", warnings: [] },
    ...(notes.length ? { notes } : {}),
  };
  plans.set(plan.planId, { plan, original, root: homeDir, actions });
  return { status: "ready", plan };
}
