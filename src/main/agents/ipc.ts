import { ipcMain } from "electron";

import {
  AGENT_JOBS_IPC_CHANNELS,
  parseAgentJobStartRequest,
  parseAgentJobStopRequest,
  parseEmptyAgentJobsRequest,
} from "../../shared/agent-jobs-ipc";
import type { AgentJobRunner } from "./runner";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;

export function registerAgentJobIpcHandlers(assertTrustedSender: SenderGuard, runner: AgentJobRunner): void {
  const guard =
    <T>(handler: (value: unknown) => Promise<T> | T) =>
    async (event: Electron.IpcMainInvokeEvent, value: unknown): Promise<T> => {
      assertTrustedSender(event);
      return handler(value);
    };
  ipcMain.handle(
    AGENT_JOBS_IPC_CHANNELS.start,
    guard((value) => runner.start(parseAgentJobStartRequest(value))),
  );
  ipcMain.handle(
    AGENT_JOBS_IPC_CHANNELS.list,
    guard((value) => {
      parseEmptyAgentJobsRequest(value);
      return { jobs: runner.list() };
    }),
  );
  ipcMain.handle(
    AGENT_JOBS_IPC_CHANNELS.stop,
    guard((value) => runner.stop(parseAgentJobStopRequest(value).jobId)),
  );
}
