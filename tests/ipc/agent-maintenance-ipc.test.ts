import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseAgentMaintenanceState,
  parseAgentSetupReceipt,
  parseAgentUpdateRetry,
  parseDisconnectAgentsRequest,
} from "../../src/shared/agent-maintenance-ipc";
import { parseApplyOperationRequest, parsePreviewOperationRequest } from "../../src/shared/operations-ipc";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
});
describe("agent maintenance IPC boundaries", () => {
  it("accepts one disconnect target and rejects unexpected fields and forged automatic approval", () => {
    expect(parsePreviewOperationRequest({ kind: "disconnect-agents", harnesses: ["codex"] })).toEqual({
      kind: "disconnect-agents",
      harnesses: ["codex"],
    });
    for (const harnesses of [[], ["codex", "claude-code"], ["other"]])
      expect(() => parseDisconnectAgentsRequest({ kind: "disconnect-agents", harnesses })).toThrow();
    expect(() =>
      parseDisconnectAgentsRequest({ kind: "disconnect-agents", harnesses: ["codex"], homeDir: "/tmp" }),
    ).toThrow();
    expect(() => parseApplyOperationRequest({ planId: "plan", provenance: { approval: "automatic" } })).toThrow();
    expect(() => parseAgentUpdateRetry({ harness: "other" })).toThrow();
  });
  it("validates maintenance state and automatic receipt metadata", () => {
    expect(
      parseAgentMaintenanceState({
        updating: ["codex"],
        failures: [],
        notice: { id: "notice-1", version: "1.2.3", harnesses: ["codex"] },
      }),
    ).toMatchObject({ updating: ["codex"] });
    expect(() =>
      parseAgentMaintenanceState({
        updating: [],
        failures: [
          { harness: "codex", reason: "error" },
          { harness: "codex", reason: "error" },
        ],
      }),
    ).toThrow();
    expect(() => parseAgentSetupReceipt({ action: "update", harnesses: [] })).toThrow();
  });
  it("guards both new main handlers and passes an explicit retry to the service", async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    vi.doMock("electron", () => ({
      ipcMain: {
        handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) =>
          handlers.set(channel, handler),
      },
    }));
    const { registerAgentMaintenanceIpc } = await import("../../src/main/agent-maintenance");
    const guard = vi.fn();
    const state = { updating: [], failures: [] };
    const retry = vi.fn(async () => state);
    registerAgentMaintenanceIpc(guard, { start: async () => undefined, snapshot: () => state, retry });
    expect(handlers.get("omni:agents:maintenance")!({}, {})).toEqual(state);
    await expect(handlers.get("omni:agents:retry-update")!({}, { harness: "codex" })).resolves.toEqual(state);
    expect(retry).toHaveBeenCalledWith({ harness: "codex" });
    expect(guard).toHaveBeenCalledTimes(2);
    guard.mockImplementation(() => {
      throw new Error("Untrusted renderer");
    });
    expect(() => handlers.get("omni:agents:maintenance")!({}, {})).toThrow("Untrusted");
  });
});
