import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { app, ipcMain } from "electron";

import type { ActivityEvidenceIo } from "../adapters/activity";
import type { ActivitySnapshot } from "../shared/activity-ipc";
import type { OperationStore } from "./operation-store";
import { createOperationStore } from "./operation-store";
import {
  removeWorktree,
  previewWorktree,
  previewProcess,
  previewRenice,
  previewSignal,
  reniceProcess,
  signalProcess,
  stopProcess,
  type StoredActivityPlan,
} from "./activity-actions";
import { absolutePath } from "./activity-paths";
import {
  allProjectRoots,
  createActivitySnapshotReader,
  registeredProjects,
  type Clock,
  type ProjectRootsReader,
} from "./activity-snapshot";
import { createRunawaySimulation, createStaleSimulation } from "./activity-simulations";
import { scanWorktrees, worktreePath } from "./activity-worktrees";
import { createPlatform, type Platform } from "./platform";
import { createActivityEvidenceIo } from "./activity-evidence-io";
import {
  ACTIVITY_IPC_CHANNELS,
  parseActivityApplyRequest,
  parseActivityOpenTerminalRequest,
  parseActivityPortsRequest,
  parseActivityPreviewRequest,
  parseActivitySimulationRequest,
  parseEmptyActivityRequest,
  type ActivityApplyResponse,
  type ActivityOpenTerminalResponse,
  type ActivityPlan,
  type ActivityPortsResponse,
  type ActivityPreviewResponse,
} from "../shared/activity-ipc";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type ActivityOptions = Readonly<{
  userDataPath?: string;
  now?: Clock;
  ttlMs?: number;
  operationStore?: OperationStore;
  platform?: Platform;
  evidenceIo?: ActivityEvidenceIo;
  activitySnapshot?: () => Promise<ActivitySnapshot>;
  projectRoots?: ProjectRootsReader;
  omniPid?: number;
  isPackaged?: boolean;
  jobSessions?: () => readonly import("../shared/activity-ipc").AgentSession[];
}>;

export function registerActivityIpcHandlers(assertTrustedSender: SenderGuard, options: ActivityOptions = {}): void {
  const userDataPath = resolve(options.userDataPath ?? app.getPath("userData"));
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const store = options.operationStore ?? createOperationStore(join(userDataPath, "omni", "operations.json"));
  const platform = options.platform ?? createPlatform();
  const projectRoots = options.projectRoots ?? (() => registeredProjects(userDataPath));
  const omniPid = options.omniPid ?? process.pid;
  const packaged = options.isPackaged ?? Boolean(app.isPackaged);
  const evidenceIo = options.evidenceIo ?? createActivityEvidenceIo(homedir());
  const readSnapshot =
    options.activitySnapshot ??
    createActivitySnapshotReader({
      userDataPath,
      now,
      platform,
      evidenceIo,
      projectRoots,
      omniPid,
      ...(options.jobSessions ? { jobSessions: options.jobSessions } : {}),
    });
  const plans = new Map<string, StoredActivityPlan>();
  const guard =
    <T>(handler: (request: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, request: unknown): Promise<T> => {
      assertTrustedSender(event);
      return handler(request);
    };
  const snapshot = async () => {
    try {
      return { status: "ready" as const, snapshot: await readSnapshot() };
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      return {
        status: "unavailable" as const,
        diagnostic: code
          ? `Activity evidence is temporarily unavailable (${code}). Retry shortly.`
          : "Activity evidence is temporarily unavailable. Retry shortly.",
      };
    }
  };
  const preview = async (raw: unknown): Promise<ActivityPreviewResponse> => {
    const request = parseActivityPreviewRequest(raw);
    if (request.kind === "stop-process" || request.kind === "signal-process" || request.kind === "renice-process") {
      const current = await platform.processes.list();
      const response =
        request.kind === "stop-process"
          ? previewProcess(request.pid, current, omniPid)
          : request.kind === "signal-process"
            ? previewSignal(request.pid, request.action, current, omniPid)
            : previewRenice(request.pid, request.nice, current, omniPid);
      if (response.status === "ready") {
        plans.set(response.plan.planId, { plan: response.plan, expiresAt: now() + ttlMs });
      }
      return response;
    }
    return previewWorktree(request, userDataPath, projectRoots, now, ttlMs, plans, evidenceIo);
  };
  const apply = async (raw: unknown): Promise<ActivityApplyResponse> => {
    const request = parseActivityApplyRequest(raw);
    const stored = plans.get(request.planId);
    if (!stored || stored.expiresAt <= now()) {
      plans.delete(request.planId);
      throw new Error("The activity preview is unavailable; preview it again.");
    }
    plans.delete(request.planId);
    if (stored.plan.kind === "stop-process") return stopProcess(stored.plan, now, store, platform);
    if (stored.plan.kind === "signal-process") return signalProcess(stored.plan, now, store, platform);
    if (stored.plan.kind === "renice-process") return reniceProcess(stored.plan, now, store, platform);
    return removeWorktree(stored, now, store);
  };
  const ports = async (raw: unknown): Promise<ActivityPortsResponse> => {
    const request = parseActivityPortsRequest(raw);
    return { ports: await platform.processes.listeningPorts(request.pids) };
  };
  const openTerminal = async (raw: unknown): Promise<ActivityOpenTerminalResponse> => {
    const request = parseActivityOpenTerminalRequest(raw);
    if (!platform.supported)
      return { status: "blocked", diagnostic: "Opening a terminal is not available on this platform." };
    const home = homedir();
    let roots;
    let worktrees;
    let currentSnapshot: ActivitySnapshot;
    try {
      roots = await allProjectRoots(userDataPath, projectRoots, evidenceIo);
      worktrees = await scanWorktrees(roots, { now: now(), evidenceIo });
      currentSnapshot = await readSnapshot();
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      return {
        status: "blocked",
        diagnostic: code
          ? `Known locations could not be verified (${code}). Retry shortly.`
          : "Known locations could not be verified. Retry shortly.",
      };
    }
    const allowed = new Set<string>();
    for (const projectRoot of roots) allowed.add(resolve(projectRoot.root));
    for (const worktree of worktrees) {
      const projectRoot = roots.find((candidate) => candidate.projectId === worktree.projectId);
      if (projectRoot) allowed.add(resolve(worktreePath(projectRoot.root, worktree)));
    }
    for (const session of currentSnapshot.sessions) allowed.add(resolve(absolutePath(session.cwd, home)));
    if (!allowed.has(resolve(request.cwd)))
      return { status: "blocked", diagnostic: "This location is not a known project, worktree, or session directory." };
    try {
      await platform.terminal.open(request.cwd);
      return { status: "opened" };
    } catch (error: unknown) {
      return {
        status: "blocked",
        diagnostic: error instanceof Error ? error.message : "The terminal could not be opened.",
      };
    }
  };
  const simulate = async (raw: unknown) => {
    const request = parseActivitySimulationRequest(raw);
    if (packaged) return { status: "unavailable" as const };
    if (request.kind === "runaway-process") {
      return { status: "available" as const, kind: request.kind, pid: await createRunawaySimulation() };
    }
    return {
      status: "available" as const,
      kind: request.kind,
      path: await createStaleSimulation(userDataPath, request.projectId),
    };
  };
  ipcMain.handle(
    ACTIVITY_IPC_CHANNELS.snapshot,
    guard(async (request) => {
      parseEmptyActivityRequest(request);
      return snapshot();
    }),
  );
  ipcMain.handle(ACTIVITY_IPC_CHANNELS.preview, guard(preview));
  ipcMain.handle(ACTIVITY_IPC_CHANNELS.apply, guard(apply));
  ipcMain.handle(ACTIVITY_IPC_CHANNELS.simulate, guard(simulate));
  ipcMain.handle(ACTIVITY_IPC_CHANNELS.ports, guard(ports));
  ipcMain.handle(ACTIVITY_IPC_CHANNELS.openTerminal, guard(openTerminal));
}
