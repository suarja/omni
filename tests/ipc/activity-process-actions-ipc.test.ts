// Split out of `activity-ipc.test.ts` to keep that file under the project's preferred
// line-count target (Brief 33c): the three IPC boundaries this brief added — signal-process /
// renice-process preview+apply, on-demand listening ports, and the open-terminal path check.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOperationStore } from "../../src/main/operation-store";
import { ACTIVITY_IPC_CHANNELS } from "../../src/shared/activity-ipc";
import { createPlatformStub } from "../main/platform-stub";
import type { Platform, RawProcess } from "../../src/main/platform/platform";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `omni-activity-${prefix}-`));
  roots.push(path);
  return path;
}
function invoke(channel: string, request: unknown = {}): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}.`);
  return handler({}, request);
}
async function load(options: {
  userDataPath: string;
  projectRoots?: readonly { projectId: string; root: string }[];
  processes?: readonly RawProcess[] | (() => readonly RawProcess[]);
  platform?: Platform;
}): Promise<void> {
  vi.doMock("electron", () => ({
    app: { getPath: vi.fn(() => options.userDataPath), isPackaged: false },
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  }));
  const module = await import("../../src/main/activity-ipc");
  module.registerActivityIpcHandlers(() => undefined, {
    userDataPath: options.userDataPath,
    projectRoots: async () => options.projectRoots ?? [],
    platform: options.platform ?? createPlatformStub({ processes: options.processes }),
    operationStore: createOperationStore(join(options.userDataPath, "operations.json")),
    omniPid: 999_999,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  handlers.clear();
  vi.resetModules();
  vi.doUnmock("electron");
});

describe("activity IPC boundary: process actions and on-demand reads (Brief 33c)", () => {
  it("previews and applies pause/resume/kill through signal-process, and renice through renice-process", async () => {
    const data = await root("signal-data");
    const signalCalls: { pid: number; action: string }[] = [];
    const reniceCalls: { pid: number; nice: number }[] = [];
    const processes: RawProcess[] = [
      { pid: 500, ppid: 1, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "codex exec --brief" },
      { pid: 501, ppid: 500, cpuPercent: 50, elapsedSeconds: 10, rssMb: 20, command: "node (vitest)" },
    ];
    await load({
      userDataPath: data,
      platform: createPlatformStub({
        processes,
        onSignal: (pid, action) => signalCalls.push({ pid, action }),
        onRenice: (pid, nice) => reniceCalls.push({ pid, nice }),
      }),
    });

    const pause = (await invoke(ACTIVITY_IPC_CHANNELS.preview, {
      kind: "signal-process",
      pid: 500,
      action: "pause",
    })) as { status: string; plan?: { planId: string } };
    expect(pause).toMatchObject({ status: "ready", plan: { kind: "signal-process", action: "pause" } });
    await expect(invoke(ACTIVITY_IPC_CHANNELS.apply, { planId: pause.plan!.planId })).resolves.toMatchObject({
      status: "applied",
      receipt: { kind: "signal-process", signalAction: "pause" },
    });
    expect(signalCalls).toEqual(
      expect.arrayContaining([
        { pid: 500, action: "pause" },
        { pid: 501, action: "pause" },
      ]),
    );

    const renice = (await invoke(ACTIVITY_IPC_CHANNELS.preview, {
      kind: "renice-process",
      pid: 500,
      nice: 10,
    })) as { status: string; plan?: { planId: string } };
    expect(renice).toMatchObject({ status: "ready", plan: { kind: "renice-process", nice: 10 } });
    await expect(invoke(ACTIVITY_IPC_CHANNELS.apply, { planId: renice.plan!.planId })).resolves.toMatchObject({
      status: "applied",
      receipt: { kind: "renice-process", nice: 10 },
    });
    expect(reniceCalls).toEqual(
      expect.arrayContaining([
        { pid: 500, nice: 10 },
        { pid: 501, nice: 10 },
      ]),
    );

    await expect(
      invoke(ACTIVITY_IPC_CHANNELS.preview, { kind: "signal-process", pid: 404, action: "kill" }),
    ).resolves.toMatchObject({ status: "blocked" });
  });

  it("reads listening ports for the requested pids from the platform", async () => {
    const data = await root("ports-data");
    await load({
      userDataPath: data,
      platform: createPlatformStub({
        processes: [],
        listeningPorts: [
          { pid: 500, port: 3000 },
          { pid: 501, port: 9334 },
        ],
      }),
    });

    await expect(invoke(ACTIVITY_IPC_CHANNELS.ports, { pids: [500, 501] })).resolves.toEqual({
      ports: [
        { pid: 500, port: 3000 },
        { pid: 501, port: 9334 },
      ],
    });
    await expect(invoke(ACTIVITY_IPC_CHANNELS.ports, { pids: [999] })).resolves.toEqual({ ports: [] });
  });

  it("opens a terminal only at a registered project root, worktree, or session cwd — never an arbitrary path", async () => {
    const data = await root("terminal-data");
    const project = await root("terminal-project");
    const opened: string[] = [];
    await load({
      userDataPath: data,
      projectRoots: [{ projectId: "terminal-project", root: project }],
      platform: createPlatformStub({ processes: [], onTerminalOpen: (cwd) => opened.push(cwd) }),
    });

    await expect(invoke(ACTIVITY_IPC_CHANNELS.openTerminal, { cwd: project })).resolves.toEqual({ status: "opened" });
    expect(opened).toEqual([project]);
    await expect(
      invoke(ACTIVITY_IPC_CHANNELS.openTerminal, { cwd: "/tmp/not-a-registered-path" }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(opened).toEqual([project]);
  });
});
