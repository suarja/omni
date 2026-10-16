import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type { AgentHarness } from "../shared/agents-ipc";
import {
  AGENT_MAINTENANCE_CHANNELS,
  parseAgentUpdateRetry,
  type AgentMaintenanceState,
} from "../shared/agent-maintenance-ipc";
import { parseEmptyAgentsRequest } from "../shared/agents-ipc";
import { observeAgentHarnesses, type AgentHarnessOptions, type AgentHarnessObservation } from "./agent-harnesses";
import { createInstallAgentsOperations } from "./operations-install-agents";
import type { OperationStore } from "./operation-store";
import type { SettingsStore } from "./settings-store";

type Options = AgentHarnessOptions &
  Readonly<{
    version: string;
    settingsStore: SettingsStore;
    operationStore: OperationStore;
    onChanged?: () => void;
  }>;
export type AgentMaintenance = Readonly<{
  start(): Promise<void>;
  snapshot(): AgentMaintenanceState;
  retry(raw: unknown): Promise<AgentMaintenanceState>;
}>;
function complete(agent: AgentHarnessObservation): boolean {
  return agent.current && agent.guard && agent.skills.every((skill) => skill.state === "installed");
}
export function createAgentMaintenance(options: Options): AgentMaintenance {
  let state: AgentMaintenanceState = { updating: [], failures: [] };
  let launch: Promise<void> | undefined;
  let launching = false;
  let running = false;
  const install = createInstallAgentsOperations({ ...options, updateVersion: options.version });
  const change = (next: AgentMaintenanceState): void => {
    state = next;
    options.onChanged?.();
  };
  const fail = (harnesses: readonly AgentHarness[], error: unknown): void => {
    const reason = error instanceof Error ? error.message : "Agent update failed. Retry from Review.";
    change({
      ...state,
      updating: state.updating.filter((item) => !harnesses.includes(item)),
      failures: [
        ...state.failures.filter((item) => !harnesses.includes(item.harness)),
        ...harnesses.map((harness) => ({ harness, reason })),
      ],
    });
  };
  const update = async (selected: readonly AgentHarness[]): Promise<void> => {
    running = true;
    const ready: AgentHarness[] = [];
    change({ ...state, updating: selected });
    try {
      // A blocked target must not prevent another connected agent from being updated.
      for (const harness of selected) {
        try {
          const preview = await install.preview({ kind: "install-agents", harnesses: [harness] });
          if (preview.status !== "ready") throw new Error(preview.diagnostic);
          ready.push(harness);
        } catch (error: unknown) {
          fail([harness], error);
        }
      }
      if (!ready.length) return;
      try {
        const preview = await install.preview({ kind: "install-agents", harnesses: ready });
        if (preview.status !== "ready") throw new Error(preview.diagnostic);
        const result = await install.apply({ planId: preview.plan.planId });
        if (result?.status !== "applied")
          throw new Error(result?.receipt.diagnostic ?? "Agent update could not be applied. Retry from Review.");
      } catch (error: unknown) {
        fail(ready, error);
        return;
      }
      change({ ...state, failures: state.failures.filter((item) => !ready.includes(item.harness)) });
      if (!state.failures.length) {
        try {
          await options.settingsStore.recordAgentVersion(options.version);
        } catch {
          fail(ready, new Error("The agent installation version could not be saved. Retry from Review."));
        }
      }
      change({ ...state, notice: { id: randomUUID(), version: options.version, harnesses: ready } });
    } finally {
      running = false;
      change({ ...state, updating: [] });
    }
  };
  const run = async (): Promise<void> => {
    const agents: AgentHarnessObservation[] = [];
    for (const harness of ["claude-code", "codex"] as const) {
      try {
        agents.push(...(await observeAgentHarnesses({ ...options, harnesses: [harness] })));
      } catch (error: unknown) {
        change({
          ...state,
          failures: [
            ...state.failures,
            {
              harness,
              reason:
                error instanceof Error
                  ? error.message
                  : "The agent installation could not be inspected. Retry from Review.",
            },
          ],
        });
      }
    }
    const eligible = agents.filter(
      (agent) => agent.registered && !agent.skills.some((skill) => skill.state === "foreign"),
    );
    let settings;
    try {
      settings = await options.settingsStore.read();
    } catch (error: unknown) {
      const reason =
        error instanceof Error ? error.message : "The agent installation version could not be read. Retry from Review.";
      change({
        ...state,
        failures: [...state.failures, ...eligible.map((agent) => ({ harness: agent.harness, reason }))],
      });
      return;
    }
    const selected = eligible.filter(
      (agent) => settings.agents.installedByVersion !== options.version || !complete(agent),
    );
    if (selected.length) await update(selected.map((agent) => agent.harness));
  };
  return {
    start: () => {
      if (!launch) {
        launching = true;
        launch = run().finally(() => {
          launching = false;
        });
      }
      return launch;
    },
    snapshot: () => state,
    retry: async (raw) => {
      const { harness } = parseAgentUpdateRetry(raw);
      if (launching || running || !state.failures.some((failure) => failure.harness === harness))
        throw new Error("This agent update is not available for retry.");
      await update([harness]);
      return state;
    },
  };
}
export function registerAgentMaintenanceIpc(
  assertSender: (event: Electron.IpcMainInvokeEvent) => void,
  service: AgentMaintenance,
): void {
  ipcMain.handle(AGENT_MAINTENANCE_CHANNELS.get, (event, value) => {
    assertSender(event);
    parseEmptyAgentsRequest(value);
    return service.snapshot();
  });
  ipcMain.handle(AGENT_MAINTENANCE_CHANNELS.retry, (event, value) => {
    assertSender(event);
    return service.retry(value);
  });
}
