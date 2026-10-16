import { ipcMain } from "electron";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  AGENTS_IPC_CHANNELS,
  parseAgentBeginApplyRequest,
  parseAgentEndApplyRequest,
  parseAgentDeclineRequest,
  parseAgentResolveRequest,
  parseEmptyAgentsRequest,
  type AgentStatus,
  type AgentRequest,
} from "../../shared/agents-ipc";
import type { AgentRequestsStore } from "./requests-store";
import type { AgentTokenManager } from "./auth";
import { observeAgentHarnesses } from "../agent-harnesses";
import type { LastSeenStore, AgentLastSeen } from "./last-seen-store";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type AgentIpcOptions = Readonly<{
  requests: AgentRequestsStore;
  refreshAgentRequest?: (requestId: string) => Promise<AgentRequest>;
  tokenManager: AgentTokenManager;
  socketPath: string;
  userDataPath: string;
  now?: () => number;
  homeDir?: string;
  cliPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  lastSeen?: LastSeenStore;
  appVersion?: string;
}>;

function displaySocketPath(socketPath: string): string {
  if (!isAbsolute(socketPath)) return socketPath;
  const home = resolve(homedir());
  const distance = relative(home, socketPath);
  return distance === ""
    ? "~"
    : !distance.startsWith("..") && !isAbsolute(distance)
      ? `~/${distance}`
      : basename(socketPath);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Agent request failed safely.";
  return message.length <= 240 &&
    !/[\r\n]/u.test(message) &&
    !/(?:password|secret|token|api[_-]?key)\s*[:=]/iu.test(message) &&
    !/(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/u.test(message)
    ? message
    : "Agent request failed safely.";
}

export function registerAgentIpcHandlers(assertTrustedSender: SenderGuard, options: AgentIpcOptions): void {
  const now = options.now ?? Date.now;
  const guard =
    <T>(handler: (value: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, value: unknown): Promise<T> => {
      assertTrustedSender(event);
      try {
        return await handler(value);
      } catch (error: unknown) {
        throw new Error(safeError(error));
      }
    };
  const status = async (): Promise<AgentStatus> => {
    const requests = await options.requests.all();
    const start = new Date(now());
    start.setHours(0, 0, 0, 0);
    const observed = await observeAgentHarnesses({
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.cliPath ? { cliPath: options.cliPath } : {}),
      ...(options.isPackaged === undefined ? {} : { isPackaged: options.isPackaged }),
      ...(options.resourcesPath ? { resourcesPath: options.resourcesPath } : {}),
      ...(options.appPath ? { appPath: options.appPath } : {}),
      userDataPath: options.userDataPath,
    });
    const lastSeen: AgentLastSeen = options.lastSeen
      ? await options.lastSeen.lastSeen()
      : { "claude-code": undefined, codex: undefined };
    return {
      ...(options.appVersion ? { appVersion: options.appVersion } : {}),
      socketPath: displaySocketPath(options.socketPath),
      tokenCreatedAt: await options.tokenManager.tokenCreatedAt(),
      counts: {
        pending: requests.filter((item) => item.status === "pending").length,
        today: requests.filter((item) => new Date(item.createdAt).getTime() >= start.getTime()).length,
        total: requests.length,
      },
      harnesses: observed.map((harness) => ({
        ...harness,
        ...(lastSeen[harness.harness] ? { lastSeenAt: lastSeen[harness.harness] } : {}),
      })),
    };
  };
  ipcMain.handle(
    AGENTS_IPC_CHANNELS.list,
    guard(async (value) => {
      parseEmptyAgentsRequest(value);
      const requests = await options.requests.list();
      if (process.env.OMNI_RECEPTION_TRACE === "1")
        console.info(`[omni-reception] main agent-list count=${requests.length}`);
      return { status: "ready" as const, requests };
    }),
  );
  ipcMain.handle(
    AGENTS_IPC_CHANNELS.refresh,
    guard(async (value) => {
      const { requestId } = parseAgentDeclineRequest(value);
      if (!options.refreshAgentRequest) throw new Error("Agent request refresh is unavailable.");
      return options.refreshAgentRequest(requestId);
    }),
  );
  ipcMain.handle(
    AGENTS_IPC_CHANNELS.beginApply,
    guard(async (value) => options.requests.acquireApplyAuthorization(parseAgentBeginApplyRequest(value).requestId)),
  );
  ipcMain.handle(
    AGENTS_IPC_CHANNELS.endApply,
    guard(async (value) => {
      const request = parseAgentEndApplyRequest(value);
      await options.requests.releaseApplyAuthorization(request.requestId, request.leaseId);
    }),
  );
  ipcMain.handle(
    AGENTS_IPC_CHANNELS.resolve,
    guard(async (value) => {
      const request = parseAgentResolveRequest(value);
      if ("operationId" in request) return options.requests.resolve(request.requestId, request.operationId);
      if (!request.leaseId || !request.approvedAt) throw new Error("Agent apply authorization is required.");
      const existing = await options.requests.get(request.requestId);
      if (!existing) throw new Error("Agent request is unavailable.");
      const harness =
        existing.harness ?? (existing.request.kind === "write-skill" ? existing.request.agent?.harness : undefined);
      const sessionName =
        existing.sessionName ??
        (existing.request.kind === "write-skill" ? existing.request.agent?.sessionName : undefined);
      return options.requests.recordApplyOutcome(
        request.requestId,
        request.operationIds,
        request.outcome,
        {
          mode: existing.approval,
          at: request.approvedAt ?? new Date(now()).toISOString(),
          ...(harness ? { harness } : {}),
          ...(sessionName ? { sessionName } : {}),
        },
        request.leaseId,
      );
    }),
  );
  ipcMain.handle(
    AGENTS_IPC_CHANNELS.decline,
    guard(async (value) => options.requests.decline(parseAgentDeclineRequest(value).requestId)),
  );
  ipcMain.handle(
    AGENTS_IPC_CHANNELS.status,
    guard(async (value) => {
      parseEmptyAgentsRequest(value);
      return status();
    }),
  );
  ipcMain.handle(
    AGENTS_IPC_CHANNELS.rotateToken,
    guard(async (value) => {
      parseEmptyAgentsRequest(value);
      await options.tokenManager.rotate();
      return status();
    }),
  );
}
