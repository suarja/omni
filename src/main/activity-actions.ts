import { randomUUID } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { OperationStore } from "./operation-store";
import { isWithin } from "./activity-paths";
import { attributeProcesses, type PsProcess } from "./activity-processes";
import { allProjectRoots, type Clock, type ProjectRootsReader } from "./activity-snapshot";
import { scanWorktrees, worktreePath, type RegisteredProjectRoot } from "./activity-worktrees";
import type { Worktree } from "../shared/activity-ipc";
import type { Platform } from "./platform/platform";
import type {
  ActivityApplyResponse,
  ActivityPlan,
  ActivityPreviewResponse,
  ActivityProcessAction,
  AgentProcess,
} from "../shared/activity-ipc";
import type { OperationReceipt } from "../shared/operations-ipc";
import type { ActivityEvidenceIo } from "../adapters/activity";
import { createActivityEvidenceIo } from "./activity-evidence-io";
import { safeGitArgs } from "./safe-git-args";

const execFile = promisify(nodeExecFile);
export type StoredActivityPlan = Readonly<{
  plan: ActivityPlan;
  expiresAt: number;
  root?: string;
  path?: string;
  worktreeKind?: "git-worktree" | "folder";
}>;

function descendants(processes: readonly AgentProcess[], pid: number): AgentProcess[] {
  const byParent = new Map<number, AgentProcess[]>();
  for (const process of processes) {
    byParent.set(process.ppid, [...(byParent.get(process.ppid) ?? []), process]);
  }
  const selected = processes.find((process) => process.pid === pid);
  if (!selected) return [];
  const result: AgentProcess[] = [];
  const visit = (process: AgentProcess): void => {
    result.push(process);
    for (const child of byParent.get(process.pid) ?? []) visit(child);
  };
  visit(selected);
  return result;
}

export async function previewWorktree(
  request: Readonly<{ projectId: string; worktreeId: string }>,
  userDataPath: string,
  projectRoots: ProjectRootsReader,
  now: Clock,
  ttlMs: number,
  plans: Map<string, StoredActivityPlan>,
  evidenceIo: ActivityEvidenceIo = createActivityEvidenceIo(),
): Promise<ActivityPreviewResponse> {
  let roots: RegisteredProjectRoot[];
  let worktrees: Worktree[];
  try {
    roots = await allProjectRoots(userDataPath, projectRoots, evidenceIo);
    worktrees = await scanWorktrees(roots, { now: now(), evidenceIo });
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
    return {
      status: "blocked",
      reason: "worktree-unavailable",
      diagnostic: code
        ? `The worktree state could not be verified (${code}). Retry shortly.`
        : "The worktree state could not be verified. Retry shortly.",
    };
  }
  const item = worktrees.find(
    (worktree) => worktree.projectId === request.projectId && worktree.id === request.worktreeId,
  );
  if (!item) {
    return {
      status: "blocked",
      reason: "worktree-unavailable",
      diagnostic: "This worktree is no longer available.",
    };
  }
  if (item.isMain) {
    return { status: "blocked", reason: "main-worktree", diagnostic: "The main checkout cannot be removed." };
  }
  if (item.dirty === true) {
    return {
      status: "blocked",
      reason: "dirty",
      diagnostic: "Commit or discard the uncommitted changes before removing this worktree.",
    };
  }
  if (item.dirty === "unknown") {
    return {
      status: "blocked",
      reason: "dirty-unknown",
      diagnostic: "The worktree state could not be verified safely.",
    };
  }
  const root = roots.find((candidate) => candidate.projectId === item.projectId)?.root;
  if (!root) {
    return {
      status: "blocked",
      reason: "worktree-unavailable",
      diagnostic: "The project root is no longer registered.",
    };
  }
  const plan: ActivityPlan = {
    planId: randomUUID(),
    kind: "remove-worktree",
    displayTarget: item.id,
    actions: [{ projectId: item.projectId, worktreeId: item.id, kind: item.kind }],
  };
  plans.set(plan.planId, {
    plan,
    expiresAt: now() + ttlMs,
    root,
    path: worktreePath(root, item),
    worktreeKind: item.kind,
  });
  return { status: "ready", plan };
}

// The eligibility rule every process action shares (D5): the pid must resolve to a non-empty
// subtree inside a harness's agent tree, and Omni's own process is never a target — whether as
// the requested pid or anywhere inside the resolved subtree.
function eligibleSubtree(
  requestPid: number,
  processes: readonly PsProcess[],
  omniPid: number,
): AgentProcess[] | undefined {
  const attributed = attributeProcesses(processes, omniPid);
  const tree = descendants(attributed, requestPid);
  if (
    !tree.length ||
    requestPid === omniPid ||
    tree.some((process) => process.agent === "omni" && process.pid === omniPid)
  ) {
    return undefined;
  }
  return tree;
}

function ineligibleResponse(): ActivityPreviewResponse {
  return {
    status: "blocked",
    reason: "process-outside-agent-tree",
    diagnostic: "This process is not a stoppable agent subtree.",
  };
}

function processActionList(tree: readonly AgentProcess[]): readonly ActivityProcessAction[] {
  return tree.map((process) => ({ pid: process.pid, command: process.command, cpuPercent: process.cpuPercent }));
}

export function previewProcess(
  requestPid: number,
  processes: readonly PsProcess[],
  omniPid: number,
): ActivityPreviewResponse {
  const tree = eligibleSubtree(requestPid, processes, omniPid);
  if (!tree) return ineligibleResponse();
  return {
    status: "ready",
    plan: {
      planId: randomUUID(),
      kind: "stop-process",
      displayTarget: tree[0]?.command ?? `process/${requestPid}`,
      actions: processActionList(tree),
    },
  };
}

export function previewSignal(
  requestPid: number,
  action: "kill" | "pause" | "resume",
  processes: readonly PsProcess[],
  omniPid: number,
): ActivityPreviewResponse {
  const tree = eligibleSubtree(requestPid, processes, omniPid);
  if (!tree) return ineligibleResponse();
  return {
    status: "ready",
    plan: {
      planId: randomUUID(),
      kind: "signal-process",
      displayTarget: tree[0]?.command ?? `process/${requestPid}`,
      action,
      actions: processActionList(tree),
    },
  };
}

export function previewRenice(
  requestPid: number,
  nice: 10 | 0,
  processes: readonly PsProcess[],
  omniPid: number,
): ActivityPreviewResponse {
  const tree = eligibleSubtree(requestPid, processes, omniPid);
  if (!tree) return ineligibleResponse();
  return {
    status: "ready",
    plan: {
      planId: randomUUID(),
      kind: "renice-process",
      displayTarget: tree[0]?.command ?? `process/${requestPid}`,
      nice,
      actions: processActionList(tree),
    },
  };
}

function activityReceipt(
  plan: ActivityPlan,
  now: Clock,
  status: OperationReceipt["status"],
  actions: OperationReceipt["actions"],
  diagnostic?: string,
  extra?: Readonly<Pick<OperationReceipt, "signalAction" | "nice">>,
): OperationReceipt {
  return {
    operationId: randomUUID(),
    kind: plan.kind,
    status,
    appliedAt: new Date(now()).toISOString(),
    displayTarget: plan.displayTarget,
    actions,
    git: { mode: "unavailable" },
    registered: null,
    ...(diagnostic ? { diagnostic } : {}),
    ...extra,
  };
}

function processReceiptActions(
  actions: readonly ActivityProcessAction[],
  statuses: ReadonlyMap<number, "applied" | "failed">,
  kind: "delete-file" | "write-file" = "delete-file",
): OperationReceipt["actions"] {
  return actions.map((action) => ({
    kind,
    relativePath: `process/${action.pid}`,
    status: statuses.get(action.pid) ?? "failed",
  }));
}

function worktreeReceiptActions(
  plan: Extract<ActivityPlan, { kind: "remove-worktree" }>,
  status: "applied" | "failed",
): OperationReceipt["actions"] {
  return plan.actions.map((action) => ({
    kind: "delete-directory" as const,
    relativePath: action.worktreeId,
    status,
  }));
}

async function waitForExit(
  pids: readonly number[],
  maxMs: number,
  isAlive: (pid: number) => boolean,
): Promise<Set<number>> {
  const alive = new Set(pids);
  const deadline = Date.now() + maxMs;
  while (alive.size && Date.now() < deadline) {
    for (const pid of [...alive]) {
      if (!isAlive(pid)) alive.delete(pid);
    }
    if (alive.size) await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  }
  return alive;
}

export async function stopProcess(
  plan: Extract<ActivityPlan, { kind: "stop-process" }>,
  now: Clock,
  store: OperationStore,
  platform: Platform,
): Promise<ActivityApplyResponse> {
  const statuses = new Map<number, "applied" | "failed">();
  for (const action of [...plan.actions].sort(
    (left, right) => plan.actions.indexOf(right) - plan.actions.indexOf(left),
  )) {
    try {
      await platform.processes.signal(action.pid, "stop");
    } catch {
      statuses.set(action.pid, "failed");
    }
  }
  const survivors = await waitForExit(
    plan.actions.map((action) => action.pid),
    2_000,
    platform.processes.isAlive,
  );
  for (const pid of survivors) {
    try {
      await platform.processes.signal(pid, "kill");
    } catch {
      // The process exited between the probes.
    }
  }
  const remaining = await waitForExit([...survivors], 100, platform.processes.isAlive);
  for (const action of plan.actions) statuses.set(action.pid, remaining.has(action.pid) ? "failed" : "applied");
  const receipt = activityReceipt(
    plan,
    now,
    [...statuses.values()].some((status) => status === "failed") ? "failed" : "applied",
    processReceiptActions(plan.actions, statuses),
  );
  await store.append(receipt);
  return { status: receipt.status, receipt };
}

// Pause/resume/kill (D5): the same subtree-wide signal `stopProcess` sends for "stop", but with
// no escalation and no wait — SIGSTOP/SIGCONT/SIGKILL either land or they don't, and there is no
// honest "graceful" version of any of the three. Not restorable (pause/resume are a reversible
// pair only in the sense that either can be requested again by hand).
export async function signalProcess(
  plan: Extract<ActivityPlan, { kind: "signal-process" }>,
  now: Clock,
  store: OperationStore,
  platform: Platform,
): Promise<ActivityApplyResponse> {
  const statuses = new Map<number, "applied" | "failed">();
  for (const action of plan.actions) {
    try {
      await platform.processes.signal(action.pid, plan.action);
      statuses.set(action.pid, "applied");
    } catch {
      statuses.set(action.pid, "failed");
    }
  }
  const receipt = activityReceipt(
    plan,
    now,
    [...statuses.values()].some((status) => status === "failed") ? "failed" : "applied",
    processReceiptActions(plan.actions, statuses),
    undefined,
    { signalAction: plan.action },
  );
  await store.append(receipt);
  return { status: receipt.status, receipt };
}

// Renice (D5): nice +10 or back to 0, subtree-wide. Not restorable — no receipt of the previous
// nice value is kept, since darwin `ps` does not expose it cheaply for every process today.
export async function reniceProcess(
  plan: Extract<ActivityPlan, { kind: "renice-process" }>,
  now: Clock,
  store: OperationStore,
  platform: Platform,
): Promise<ActivityApplyResponse> {
  const statuses = new Map<number, "applied" | "failed">();
  for (const action of plan.actions) {
    try {
      await platform.processes.renice(action.pid, plan.nice);
      statuses.set(action.pid, "applied");
    } catch {
      statuses.set(action.pid, "failed");
    }
  }
  const receipt = activityReceipt(
    plan,
    now,
    [...statuses.values()].some((status) => status === "failed") ? "failed" : "applied",
    processReceiptActions(plan.actions, statuses, "write-file"),
    undefined,
    { nice: plan.nice },
  );
  await store.append(receipt);
  return { status: receipt.status, receipt };
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "Worktree could not be removed safely.";
  if (message.length > 200 || /[\r\n]/u.test(message) || /(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/u.test(message))
    return "Worktree could not be removed safely.";
  return message;
}

export async function removeWorktree(
  stored: StoredActivityPlan,
  now: Clock,
  store: OperationStore,
): Promise<ActivityApplyResponse> {
  const plan = stored.plan as Extract<ActivityPlan, { kind: "remove-worktree" }>;
  try {
    if (
      !stored.root ||
      !stored.path ||
      !stored.worktreeKind ||
      !isWithin(stored.root, stored.path) ||
      resolve(stored.root) === resolve(stored.path)
    )
      throw new Error("The approved worktree path is no longer safe.");
    const root = await realpath(stored.root);
    const path = await realpath(stored.path);
    if (!isWithin(root, path)) throw new Error("The approved worktree path is no longer safe.");
    if (stored.worktreeKind === "git-worktree") {
      await execFile("git", safeGitArgs(["worktree", "remove", "--", path]), {
        cwd: root,
        shell: false,
        windowsHide: true,
      });
    } else {
      await rm(path, { recursive: true, force: true });
    }
    await execFile("git", safeGitArgs(["worktree", "prune"]), {
      cwd: root,
      shell: false,
      windowsHide: true,
    }).catch(() => undefined);
    const receipt = activityReceipt(plan, now, "applied", worktreeReceiptActions(plan, "applied"));
    await store.append(receipt);
    return { status: "applied", receipt };
  } catch (error: unknown) {
    const receipt = activityReceipt(plan, now, "failed", worktreeReceiptActions(plan, "failed"), safeDiagnostic(error));
    await store.append(receipt);
    return { status: "failed", receipt };
  }
}
