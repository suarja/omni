import type { AgentHarness } from "./agents-ipc";
import { assertKeys, assertRecord, readOpaque, readText } from "./operations-ipc-parser-utils";

export const AGENT_MAINTENANCE_CHANNELS = {
  get: "omni:agents:maintenance",
  retry: "omni:agents:retry-update",
} as const;
export type AgentUpdateFailure = Readonly<{ harness: AgentHarness; reason: string }>;
export type AgentUpdateNotice = Readonly<{ id: string; version: string; harnesses: readonly AgentHarness[] }>;
export type AgentMaintenanceState = Readonly<{
  updating: readonly AgentHarness[];
  failures: readonly AgentUpdateFailure[];
  notice?: AgentUpdateNotice;
}>;
export type DisconnectAgentsRequest = Readonly<{ kind: "disconnect-agents"; harnesses: readonly AgentHarness[] }>;
export type AgentSetupReceipt = Readonly<{
  action: "connect" | "reinstall" | "update" | "disconnect";
  harnesses: readonly AgentHarness[];
  version?: string;
}>;
function harness(value: unknown): AgentHarness {
  if (value !== "claude-code" && value !== "codex") throw new Error("Agent harness is invalid.");
  return value;
}
function harnesses(value: unknown): readonly AgentHarness[] {
  if (!Array.isArray(value)) throw new Error("Agent harnesses must be an array.");
  const result = value.map(harness);
  if (new Set(result).size !== result.length) throw new Error("Agent harnesses must be unique.");
  return result;
}
export function parseDisconnectAgentsRequest(value: unknown): DisconnectAgentsRequest {
  const request = assertRecord(value, "Agent disconnection request");
  assertKeys(request, ["kind", "harnesses"], "Agent disconnection request");
  const selected = harnesses(request.harnesses);
  if (request.kind !== "disconnect-agents" || selected.length !== 1) throw new Error("Disconnect one agent at a time.");
  return { kind: request.kind, harnesses: selected };
}
export function parseAgentUpdateRetry(value: unknown): Readonly<{ harness: AgentHarness }> {
  const request = assertRecord(value, "Agent update retry");
  assertKeys(request, ["harness"], "Agent update retry");
  return { harness: harness(request.harness) };
}
export function parseAgentMaintenanceState(value: unknown): AgentMaintenanceState {
  const state = assertRecord(value, "Agent maintenance state");
  assertKeys(state, ["updating", "failures", "notice"], "Agent maintenance state");
  if (!Array.isArray(state.failures)) throw new Error("Agent update failures must be an array.");
  const failures = state.failures.map((value) => {
    const failure = assertRecord(value, "Agent update failure");
    assertKeys(failure, ["harness", "reason"], "Agent update failure");
    return { harness: harness(failure.harness), reason: readText(failure.reason, "Agent update reason") };
  });
  if (new Set(failures.map((failure) => failure.harness)).size !== failures.length)
    throw new Error("Agent update failures must be unique.");
  const notice = state.notice === undefined ? undefined : assertRecord(state.notice, "Agent update notice");
  if (notice) assertKeys(notice, ["id", "version", "harnesses"], "Agent update notice");
  return {
    updating: harnesses(state.updating),
    failures,
    ...(notice
      ? {
          notice: {
            id: readOpaque(notice.id, "Agent update notice id"),
            version: readText(notice.version, "Agent update version"),
            harnesses: harnesses(notice.harnesses),
          },
        }
      : {}),
  };
}
export function parseAgentSetupReceipt(value: unknown): AgentSetupReceipt {
  const receipt = assertRecord(value, "Agent setup receipt");
  assertKeys(receipt, ["action", "harnesses", "version"], "Agent setup receipt");
  if (
    receipt.action !== "connect" &&
    receipt.action !== "reinstall" &&
    receipt.action !== "update" &&
    receipt.action !== "disconnect"
  )
    throw new Error("Agent setup action is invalid.");
  const selected = harnesses(receipt.harnesses);
  if (!selected.length) throw new Error("Agent setup receipt requires an agent.");
  return {
    action: receipt.action,
    harnesses: selected,
    ...(receipt.version === undefined ? {} : { version: readText(receipt.version, "Agent setup version") }),
  };
}
export interface AgentMaintenanceDesktopApi {
  getAgentMaintenance(): Promise<AgentMaintenanceState>;
  retryAgentUpdate(request: Readonly<{ harness: AgentHarness }>): Promise<AgentMaintenanceState>;
}
