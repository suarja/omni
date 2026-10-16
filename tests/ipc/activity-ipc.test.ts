import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOperationStore } from "../../src/main/operation-store";
import { buildActivitySnapshot } from "../../src/main/activity-snapshot";
import { ACTIVITY_IPC_CHANNELS, parseActivitySnapshotResponse } from "../../src/shared/activity-ipc";
import { createPlatformStub } from "../main/platform-stub";
import { posixIsAlive, posixSignal } from "../../src/main/platform/posix";
import type { Platform, RawProcess } from "../../src/main/platform/platform";

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const roots: string[] = [];
const children: ChildProcess[] = [];
const simulationPids: number[] = [];

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
  evidenceIo?: import("../../src/adapters/activity").ActivityEvidenceIo;
  activitySnapshot?: () => Promise<import("../../src/shared/activity-ipc").ActivitySnapshot>;
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
    ...(options.evidenceIo ? { evidenceIo: options.evidenceIo } : {}),
    ...(options.activitySnapshot ? { activitySnapshot: options.activitySnapshot } : {}),
    operationStore: createOperationStore(join(options.userDataPath, "operations.json")),
    omniPid: 999_999,
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const pid of simulationPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  handlers.clear();
  vi.resetModules();
  vi.doUnmock("electron");
});

describe("activity IPC boundary", () => {
  it("returns an explicit unavailable response when isolated directory evidence fails", async () => {
    const data = await root("snapshot-unavailable");
    await load({
      userDataPath: data,
      evidenceIo: {
        homeDir: data,
        now: Date.now,
        readText: async () => null,
        readDir: async () => {
          const error = new Error("isolated read timed out") as NodeJS.ErrnoException;
          error.code = "directory-reader-timeout";
          throw error;
        },
        stat: async () => null,
      },
    });

    await expect(invoke(ACTIVITY_IPC_CHANNELS.snapshot)).resolves.toMatchObject({
      status: "unavailable",
      diagnostic: expect.stringContaining("directory-reader-timeout"),
    });
  });

  it("blocks open-terminal when the current snapshot cannot verify a known location", async () => {
    const data = await root("open-terminal-unavailable");
    const openTerminal = vi.fn();
    const snapshotFailure = Object.assign(new Error("isolated read timed out"), {
      code: "directory-reader-timeout",
    });
    await load({
      userDataPath: data,
      evidenceIo: {
        homeDir: data,
        now: Date.now,
        readText: async () => null,
        readDir: async () => [],
        stat: async () => null,
      },
      platform: createPlatformStub({ onTerminalOpen: openTerminal }),
      activitySnapshot: async () => {
        throw snapshotFailure;
      },
    });

    await expect(invoke(ACTIVITY_IPC_CHANNELS.openTerminal, { cwd: data })).resolves.toMatchObject({
      status: "blocked",
      diagnostic: expect.stringContaining("directory-reader-timeout"),
    });
    expect(openTerminal).not.toHaveBeenCalled();
  });
  it("builds the v2 snapshot with bounded Claude evidence reads", async () => {
    const data = await root("snapshot-v2");
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    const calls: { path: string; options: { head?: number; tail?: number } }[] = [];
    const processes = Array.from({ length: 20 }, (_, index) => ({
      pid: 1_000 + index,
      ppid: 1,
      cpuPercent: index,
      elapsedSeconds: 10,
      rssMb: 10,
      command: "claude",
      startedAt: now,
      cwd: `/Users/example/project-${index}`,
    }));
    const evidenceIo = {
      homeDir: "/Users/example",
      now: () => now,
      readText: async (path: string, options: { head?: number; tail?: number }) => {
        calls.push({ path, options });
        if (path.includes("/sessions/")) {
          const pid = Number(path.match(/(\d+)\.json$/u)?.[1]);
          return JSON.stringify({
            pid,
            sessionId: `session-${pid}`,
            cwd: `/Users/example/project-${(pid ?? 1_000) - 1_000}`,
            startedAt: now,
          });
        }
        return JSON.stringify({ slug: "project", cwd: "/Users/example/project", timestamp: now });
      },
      readDir: async () => [],
      stat: async () => null,
    };

    const snapshot = await buildActivitySnapshot({
      userDataPath: data,
      now: () => now,
      platform: createPlatformStub({ processes }),
      evidenceIo,
      projectRoots: async () => [],
      omniPid: 999_999,
    });

    expect(snapshot.sessions).toHaveLength(20);
    expect(snapshot.processes.every((process) => process.sessionId)).toBe(true);
    expect(calls.filter((call) => call.path.includes("/.claude/sessions/")).length).toBe(20);
    expect(calls.filter((call) => call.path.includes("/.claude/projects/")).length).toBe(40);
    expect(calls.every((call) => !call.options.head || call.options.head <= 128 * 1024)).toBe(true);
  });

  it("rejects unsafe v2 display paths and newlines at the preload parser boundary", () => {
    const process = {
      pid: 1,
      ppid: 1,
      agent: "codex",
      name: "Codex agent",
      command: "codex exec",
      cpuPercent: 0,
      elapsedSeconds: 0,
      rssMb: 0,
      depth: 0,
      flags: [],
    };
    const session = {
      id: "codex:session-1",
      harness: "codex",
      pid: 1,
      entrypoint: "exec",
      name: "Codex exec",
      cwd: "~/project",
      startedAt: 1,
      link: "rollout-match",
      processPids: [1],
      worktreeIds: [],
      totals: { cpuPercent: 0, rssMb: 0 },
      flags: [],
    };
    const response = {
      status: "ready",
      snapshot: { sessions: [session], processes: [process], worktrees: [] },
    } as const;

    expect(parseActivitySnapshotResponse(response)).toMatchObject({ status: "ready" });
    expect(
      parseActivitySnapshotResponse({
        ...response,
        snapshot: { ...response.snapshot, sessions: [{ ...session, cwd: "/" }] },
      }),
    ).toMatchObject({ status: "ready" });
    expect(() =>
      parseActivitySnapshotResponse({
        ...response,
        snapshot: { ...response.snapshot, sessions: [{ ...session, cwd: "~/project/../secret" }] },
      }),
    ).toThrow();
    expect(() =>
      parseActivitySnapshotResponse({
        ...response,
        snapshot: { ...response.snapshot, sessions: [{ ...session, cwd: "project" }] },
      }),
    ).toThrow();
    expect(() =>
      parseActivitySnapshotResponse({
        ...response,
        snapshot: { ...response.snapshot, processes: [{ ...process, name: "bad\nname" }] },
      }),
    ).toThrow();
  });

  it("parses the session title and activity fields, bounded and all optional", () => {
    const session = {
      id: "codex:session-1",
      harness: "codex",
      pid: 1,
      entrypoint: "exec",
      name: "Codex exec",
      cwd: "~/project",
      startedAt: 1,
      link: "rollout-match",
      processPids: [1],
      worktreeIds: [],
      totals: { cpuPercent: 0, rssMb: 0 },
      flags: [],
    };
    const response = {
      status: "ready",
      snapshot: { sessions: [session], processes: [], worktrees: [] },
    } as const;

    // Every activity field is optional: an empty object parses cleanly.
    expect(
      parseActivitySnapshotResponse({
        ...response,
        snapshot: { ...response.snapshot, sessions: [{ ...session, title: "My session", activity: {} }] },
      }),
    ).toMatchObject({ status: "ready", snapshot: { sessions: [{ title: "My session", activity: {} }] } });

    const fullActivity = {
      firstPrompt: "a".repeat(600),
      latestPrompt: "b".repeat(600),
      latestPromptAt: 2,
      lastTool: { name: "Bash", target: "git status" },
      turns: 42,
      tailTruncated: true,
      lastAnswerAt: 3,
      subagents: 2,
    };
    expect(
      parseActivitySnapshotResponse({
        ...response,
        snapshot: { ...response.snapshot, sessions: [{ ...session, activity: fullActivity }] },
      }),
    ).toMatchObject({ status: "ready", snapshot: { sessions: [{ activity: fullActivity }] } });

    expect(() =>
      parseActivitySnapshotResponse({
        ...response,
        snapshot: { ...response.snapshot, sessions: [{ ...session, title: "a".repeat(201) }] },
      }),
    ).toThrow();
    expect(() =>
      parseActivitySnapshotResponse({
        ...response,
        snapshot: {
          ...response.snapshot,
          sessions: [{ ...session, activity: { firstPrompt: "a".repeat(601) } }],
        },
      }),
    ).toThrow();
    expect(() =>
      parseActivitySnapshotResponse({
        ...response,
        snapshot: {
          ...response.snapshot,
          sessions: [{ ...session, activity: { lastTool: { name: "Bash", extra: "nope" } } }],
        },
      }),
    ).toThrow();
    expect(() =>
      parseActivitySnapshotResponse({
        ...response,
        snapshot: { ...response.snapshot, sessions: [{ ...session, activity: { tailTruncated: "yes" } }] },
      }),
    ).toThrow();
  });

  it("previews and applies stopping a leaf, then records a receipt", async () => {
    const data = await root("data");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.push(child);
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const processes: RawProcess[] = [
      { pid: 300, ppid: 1, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "codex exec --brief" },
      { pid: child.pid!, ppid: 300, cpuPercent: 95, elapsedSeconds: 180, rssMb: 20, command: "node (vitest)" },
    ];
    // The process tree is fabricated (a real child spawned above stands in for the leaf), but
    // stopping it must still send real signals to a real pid, so this platform pairs the fake
    // tree with the real POSIX signal/liveness primitives rather than the in-memory stub.
    const platform: Platform = {
      id: "darwin",
      supported: true,
      processes: {
        list: async () => processes,
        workingDirectories: async () => new Map(),
        signal: posixSignal,
        isAlive: posixIsAlive,
        listeningPorts: async () => [],
        renice: async () => undefined,
      },
      terminal: { open: async () => undefined },
      gateway: { endpoint: () => join(data, "omni", "agent.sock"), secure: async () => undefined },
    };
    await load({ userDataPath: data, platform });

    const preview = (await invoke(ACTIVITY_IPC_CHANNELS.preview, { kind: "stop-process", pid: child.pid })) as {
      status: string;
      plan?: { planId: string; actions: unknown[] };
    };
    expect(preview).toMatchObject({ status: "ready", plan: { kind: "stop-process", actions: [{ pid: child.pid }] } });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const applied = (await invoke(ACTIVITY_IPC_CHANNELS.apply, { planId: preview.plan!.planId })) as {
      status: string;
      receipt: { kind: string; actions: { status: string }[] };
    };
    expect(applied).toMatchObject({
      status: "applied",
      receipt: { kind: "stop-process", actions: [{ status: "applied" }] },
    });
    await exited;
    expect(child.signalCode).not.toBeNull();
  });

  it("blocks an unclean worktree and removes a clean worktree after preview", async () => {
    const data = await root("worktree-data");
    const project = await root("project");
    await (await import("node:child_process")).execFileSync("git", ["init", "-q"], { cwd: project });
    await (
      await import("node:child_process")
    ).execFileSync("git", ["config", "user.email", "ada@example.com"], { cwd: project });
    await (
      await import("node:child_process")
    ).execFileSync("git", ["config", "user.name", "Omni Test"], { cwd: project });
    await writeFile(join(project, "root.txt"), "root\n", "utf8");
    await (await import("node:child_process")).execFileSync("git", ["add", "root.txt"], { cwd: project });
    await (await import("node:child_process")).execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: project });
    const worktree = join(project, "wt");
    await (
      await import("node:child_process")
    ).execFileSync("git", ["worktree", "add", "-q", "-b", "activity/test", worktree], { cwd: project });
    await load({ userDataPath: data, projectRoots: [{ projectId: "project", root: project }] });
    const preview = (await invoke(ACTIVITY_IPC_CHANNELS.preview, {
      kind: "remove-worktree",
      projectId: "project",
      worktreeId: "wt",
    })) as { status: string; plan?: { planId: string } };
    expect(preview.status).toBe("ready");
    await expect(invoke(ACTIVITY_IPC_CHANNELS.apply, { planId: preview.plan!.planId })).resolves.toMatchObject({
      status: "applied",
      receipt: { kind: "remove-worktree" },
    });
    await expect(import("node:fs/promises").then(({ stat }) => stat(worktree))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const dirtyWorktree = join(project, "wt-dirty");
    await (
      await import("node:child_process")
    ).execFileSync("git", ["worktree", "add", "-q", "-b", "activity/dirty", dirtyWorktree], { cwd: project });
    await mkdir(dirtyWorktree, { recursive: true });
    await writeFile(join(dirtyWorktree, "dirty.txt"), "dirty\n", "utf8");
    await expect(
      invoke(ACTIVITY_IPC_CHANNELS.preview, { kind: "remove-worktree", projectId: "project", worktreeId: "wt-dirty" }),
    ).resolves.toMatchObject({ status: "blocked", reason: "dirty" });
  });

  it("exposes dev simulations and blocks unknown process targets", async () => {
    const data = await root("simulation-data");
    let simulationPid: number | undefined;
    await load({
      userDataPath: data,
      processes: () =>
        simulationPid === undefined
          ? []
          : [
              {
                pid: simulationPid,
                ppid: 1,
                cpuPercent: 12.4,
                elapsedSeconds: 1,
                rssMb: 20,
                command: "node -e omni-sim-runaway",
              },
            ],
    });
    await expect(invoke(ACTIVITY_IPC_CHANNELS.preview, { kind: "stop-process", pid: 404 })).resolves.toMatchObject({
      status: "blocked",
    });
    const simulation = (await invoke(ACTIVITY_IPC_CHANNELS.simulate, { kind: "runaway-process" })) as {
      status: string;
      pid: number;
    };
    expect(simulation).toMatchObject({ status: "available", pid: expect.any(Number) });
    simulationPid = simulation.pid;
    simulationPids.push(simulation.pid);
    expect(() => process.kill(simulation.pid, 0)).not.toThrow();
    const activity = (await invoke(ACTIVITY_IPC_CHANNELS.snapshot)) as {
      snapshot: { processes: { pid: number; agent: string; command: string; cpuPercent: number }[] };
    };
    expect(activity.snapshot.processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: simulation.pid,
          agent: "simulation",
          command: expect.stringMatching(/^node -e /u),
        }),
      ]),
    );
    expect(
      activity.snapshot.processes.find((process) => process.pid === simulation.pid)?.cpuPercent,
    ).toBeGreaterThanOrEqual(0);
    const stale = (await invoke(ACTIVITY_IPC_CHANNELS.simulate, { kind: "stale-worktree", projectId: "demo" })) as {
      status: string;
      path: string;
    };
    expect(stale).toMatchObject({
      status: "available",
      path: expect.stringContaining("simulations/demo/repo/.worktrees/wt-1"),
    });
    const finalActivity = (await invoke(ACTIVITY_IPC_CHANNELS.snapshot)) as {
      snapshot: { worktrees: { projectId: string; branch?: string; lastActivityDays: number }[] };
    };
    expect(finalActivity.snapshot.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "simulation-demo",
          branch: "sim/1",
          lastActivityDays: expect.any(Number),
        }),
      ]),
    );
  });
});
