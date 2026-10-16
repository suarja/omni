import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type {
  OperationAction,
  OperationPlan,
  OperationReceipt,
  ApplyOperationResponse,
} from "../shared/operations-ipc";
import { parseApplyOperationRequest } from "../shared/operations-ipc";
import type { OperationStore } from "./operation-store";
import { hashContent } from "./marketplace-manifests";
import { harnessPaths } from "./agent-harnesses";
import { isMissing } from "./fs-optional";
import { backupFiles, removeDirectoryIfEmpty } from "./operation-files";
import { applyAgentFile, verifyAgentFile, verifyWrittenAgentFile, rollBackAgentFiles } from "./agent-file-actions";
import { refreshGuardConfig } from "./guard-ipc";
export type AgentFileAction = OperationAction &
  Readonly<{ absolutePath: string; content?: string; beforeContent?: string }>;
export type AgentFileMetadata = Pick<OperationReceipt, "agentSetup" | "provenance" | "harness">;
type StoredPlan = Readonly<{
  plan: OperationPlan;
  operationId: string;
  actions: readonly AgentFileAction[];
  homeDir: string;
  cliPath: string;
  metadata: AgentFileMetadata;
}>;
type PlannedAction = AgentFileAction;
function hash(content: string | Uint8Array): string {
  return hashContent(content);
}
function view(action: PlannedAction): OperationAction {
  const { absolutePath: _path, content: _content, beforeContent: _before, ...result } = action;
  return result;
}
const MANIFEST_RELATIVE_PATHS = new Set(
  (["claude-code", "codex"] as const).flatMap((harness) => [
    harnessPaths(harness).settings,
    harnessPaths(harness).guardSettings,
  ]),
);
function manifestDisplayPath(path: string): string {
  for (const harness of ["claude-code", "codex"] as const) {
    const paths = harnessPaths(harness);
    if (paths.settings === path) return paths.settingsDisplay;
    if (paths.guardSettings === path) return paths.guardSettingsDisplay;
  }
  return path;
}
async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
function appliedReceipt(
  stored: StoredPlan,
  completed: readonly PlannedAction[],
  createdDirectories: readonly string[],
  at: number,
): OperationReceipt {
  const skillFiles = completed.filter(
    (action) =>
      (action.kind === "write-file" || action.kind === "delete-file") &&
      (action.relativePath.startsWith(".claude/skills/") || action.relativePath.startsWith(".codex/skills/")),
  );
  const manifests = completed.filter((action) => MANIFEST_RELATIVE_PATHS.has(action.relativePath));
  return {
    operationId: stored.operationId,
    kind: stored.plan.kind,
    status: "applied",
    appliedAt: new Date(at).toISOString(),
    displayTarget: stored.plan.displayTarget,
    actions: completed.map((action) => ({ ...view(action), status: "applied" as const })),
    git: { mode: "not-a-repository" },
    registered: null,
    cliPath: stored.cliPath,
    ...stored.metadata,
    files: skillFiles.map((action) => ({
      relativePath: action.relativePath,
      contentHash: action.kind === "write-file" ? hash(action.content ?? "") : hash(action.beforeContent ?? ""),
      ...(action.beforeHash ? { previousHash: action.beforeHash } : {}),
    })),
    manifests: manifests.map((action) => ({
      relativePath: manifestDisplayPath(action.relativePath),
      ...(action.beforeHash ? { beforeHash: action.beforeHash } : {}),
      afterHash: hash(action.content ?? ""),
    })),
    createdDirectories,
  };
}
function failedReceipt(
  stored: StoredPlan,
  restored: ReadonlySet<PlannedAction>,
  errors: readonly string[],
  error: unknown,
  backupRoot: string,
  at: number,
): OperationReceipt {
  return {
    operationId: stored.operationId,
    kind: stored.plan.kind,
    status: "failed",
    appliedAt: new Date(at).toISOString(),
    displayTarget: stored.plan.displayTarget,
    actions: stored.actions.map((action) => ({
      ...view(action),
      status: restored.has(action) ? ("rolled-back" as const) : ("failed" as const),
    })),
    git: { mode: "not-a-repository" },
    registered: null,
    cliPath: stored.cliPath,
    ...stored.metadata,
    diagnostic: [
      error instanceof Error ? error.message : "The agent operation failed.",
      ...(errors.length
        ? [
            `Some files could not be restored: ${errors.join("; ")}. Preserve the files and inspect ${backupRoot} before retrying.`,
          ]
        : []),
    ].join(" "),
  };
}
export function createAgentFileOperations(
  options: Readonly<{ userDataPath: string; homeDir: string; operationStore: OperationStore; now?: () => number }>,
): Readonly<{
  remember(
    plan: OperationPlan,
    actions: readonly AgentFileAction[],
    cliPath: string,
    metadata: AgentFileMetadata,
  ): void;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const store = options.operationStore;
  const now = options.now ?? Date.now;
  const plans = new Map<string, StoredPlan>();
  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored) return undefined;
    plans.delete(request.planId);
    const backupRoot = join(options.userDataPath, "omni", "backups", stored.operationId);
    const completed: PlannedAction[] = [];
    const createdDirectories: string[] = [];
    try {
      for (const action of stored.actions) await verifyAgentFile(stored.homeDir, action);
      const backupPaths = [
        ...new Set(stored.actions.filter((action) => action.beforeHash).map((action) => action.relativePath)),
      ];
      if (backupPaths.length) await backupFiles(stored.homeDir, backupRoot, backupPaths);
      for (const action of stored.actions) {
        if (action.kind === "create-directory" && !(await directoryExists(action.absolutePath)))
          createdDirectories.push(action.relativePath);
        await applyAgentFile(stored.homeDir, action);
        completed.push(action);
        await verifyWrittenAgentFile(stored.homeDir, action);
      }
      const receipt = appliedReceipt(stored, completed, createdDirectories, now());
      const saved = await store.append(receipt);
      if (saved.status !== "ready") throw new Error("The agent installation receipt could not be persisted safely.");
      // New registry entries need protection without waiting for the next app launch.
      await refreshGuardConfig({ userDataPath: options.userDataPath }).catch(() => undefined);
      return { status: "applied", receipt };
    } catch (error: unknown) {
      const rollback = await rollBackAgentFiles(stored.homeDir, backupRoot, completed);
      const cleanupErrors: string[] = [];
      for (const path of [...createdDirectories].reverse()) {
        try {
          await removeDirectoryIfEmpty(stored.homeDir, path);
        } catch {
          cleanupErrors.push(path);
        }
      }
      const errors = [...rollback.errors, ...cleanupErrors];
      const receipt = failedReceipt(stored, rollback.restored, errors, error, backupRoot, now());
      await store.append(receipt).catch(() => undefined);
      return { status: "failed", receipt };
    }
  };
  return {
    remember: (plan, actions, cliPath, metadata) => {
      plans.set(plan.planId, { plan, actions, cliPath, metadata, homeDir: options.homeDir, operationId: randomUUID() });
    },
    apply,
  };
}
