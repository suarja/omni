import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  previewWorktree,
  previewProcess,
  previewRenice,
  previewSignal,
  reniceProcess,
  signalProcess,
} from "../../src/main/activity-actions";
import { createOperationStore } from "../../src/main/operation-store";
import type { RawProcess } from "../../src/main/platform/platform";
import type { ActivityPlan } from "../../src/shared/activity-ipc";
import { IsolatedDirectoryReaderError } from "../../src/main/isolated-directory-reader";
import { createPlatformStub } from "./platform-stub";

const OMNI_PID = 999_999;
const TREE: readonly RawProcess[] = [
  { pid: 300, ppid: 1, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "codex exec --brief" },
  { pid: 301, ppid: 300, cpuPercent: 50, elapsedSeconds: 100, rssMb: 20, command: "node (vitest)" },
  { pid: 302, ppid: 301, cpuPercent: 10, elapsedSeconds: 5, rssMb: 5, command: "node (vitest 1)" },
];

const roots: string[] = [];
async function tempOperationsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omni-activity-actions-"));
  roots.push(dir);
  return join(dir, "operations.json");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("activity actions: signal-process and renice-process eligibility (same rule as stop-process)", () => {
  it("blocks a pid outside any agent tree, and Omni's own pid", () => {
    expect(previewSignal(9_999, "kill", TREE, OMNI_PID)).toMatchObject({ status: "blocked" });
    expect(previewSignal(OMNI_PID, "kill", TREE, OMNI_PID)).toMatchObject({ status: "blocked" });
    expect(previewRenice(9_999, 10, TREE, OMNI_PID)).toMatchObject({ status: "blocked" });
  });

  it("resolves the whole subtree from the requested pid, root or nested", () => {
    const fromRoot = previewSignal(300, "pause", TREE, OMNI_PID);
    expect(fromRoot).toMatchObject({
      status: "ready",
      plan: { kind: "signal-process", action: "pause", actions: [{ pid: 300 }, { pid: 301 }, { pid: 302 }] },
    });
    const fromNested = previewSignal(301, "resume", TREE, OMNI_PID);
    expect(fromNested).toMatchObject({
      status: "ready",
      plan: { kind: "signal-process", action: "resume", actions: [{ pid: 301 }, { pid: 302 }] },
    });
  });

  it("previews a renice plan carrying the requested nice value and subtree", () => {
    const response = previewRenice(300, 10, TREE, OMNI_PID);
    expect(response).toMatchObject({
      status: "ready",
      plan: { kind: "renice-process", nice: 10, actions: [{ pid: 300 }, { pid: 301 }, { pid: 302 }] },
    });
  });

  it("still blocks stop-process eligibility identically (unchanged behaviour)", () => {
    expect(previewProcess(9_999, TREE, OMNI_PID)).toMatchObject({ status: "blocked" });
    expect(previewProcess(300, TREE, OMNI_PID)).toMatchObject({ status: "ready" });
  });
});

describe("activity actions: worktree preview scan failures", () => {
  it("blocks a worktree preview without storing a plan when directory evidence is unavailable", async () => {
    const plans = new Map();
    const preview = await previewWorktree(
      { projectId: "project-one", worktreeId: "feature" },
      "/fixture/profile",
      async () => [{ projectId: "project-one", root: "/fixture/project" }],
      () => Date.now(),
      60_000,
      plans,
      {
        homeDir: "/fixture/home",
        now: Date.now,
        readText: async () => null,
        readDir: async () => {
          throw new IsolatedDirectoryReaderError("directory-reader-timeout", "/fixture/project/.worktrees");
        },
        stat: async () => null,
      },
    );

    expect(preview).toMatchObject({ status: "blocked", reason: "worktree-unavailable" });
    expect(plans.size).toBe(0);
  });
});

describe("activity actions: signalProcess apply", () => {
  it("sends the requested signal to every pid in the subtree and records a signal-process receipt", async () => {
    const calls: { pid: number; action: string }[] = [];
    const platform = createPlatformStub({ processes: TREE, onSignal: (pid, action) => calls.push({ pid, action }) });
    const store = createOperationStore(await tempOperationsFile());
    const now = () => Date.parse("2026-09-14T12:00:00.000Z");
    const response = previewSignal(300, "kill", TREE, OMNI_PID);
    if (response.status !== "ready") throw new Error("expected a ready preview");

    const applied = await signalProcess(
      response.plan as Extract<ActivityPlan, { kind: "signal-process" }>,
      now,
      store,
      platform,
    );

    expect(applied.status).toBe("applied");
    expect(applied.receipt).toMatchObject({
      kind: "signal-process",
      status: "applied",
      signalAction: "kill",
      actions: [
        { relativePath: "process/300", status: "applied" },
        { relativePath: "process/301", status: "applied" },
        { relativePath: "process/302", status: "applied" },
      ],
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        { pid: 300, action: "kill" },
        { pid: 301, action: "kill" },
        { pid: 302, action: "kill" },
      ]),
    );
    const stored = await store.read();
    expect(stored).toMatchObject({ status: "ready", receipts: [{ kind: "signal-process" }] });
  });

  it("reports a failed status and per-pid failure when the platform signal rejects", async () => {
    const platform = createPlatformStub({
      processes: TREE,
      onSignal: (pid) => {
        if (pid === 301) throw new Error("ESRCH");
      },
    });
    const store = createOperationStore(await tempOperationsFile());
    const now = () => Date.parse("2026-09-14T12:00:00.000Z");
    const response = previewSignal(300, "pause", TREE, OMNI_PID);
    if (response.status !== "ready") throw new Error("expected a ready preview");

    const applied = await signalProcess(
      response.plan as Extract<ActivityPlan, { kind: "signal-process" }>,
      now,
      store,
      platform,
    );

    expect(applied.status).toBe("failed");
    expect(applied.receipt.actions.find((action) => action.relativePath === "process/301")).toMatchObject({
      status: "failed",
    });
    expect(applied.receipt.actions.find((action) => action.relativePath === "process/300")).toMatchObject({
      status: "applied",
    });
  });
});

describe("activity actions: reniceProcess apply", () => {
  it("renices every pid in the subtree and records a renice-process receipt with no restore offered", async () => {
    const calls: { pid: number; nice: number }[] = [];
    const platform = createPlatformStub({ processes: TREE, onRenice: (pid, nice) => calls.push({ pid, nice }) });
    const store = createOperationStore(await tempOperationsFile());
    const now = () => Date.parse("2026-09-14T12:00:00.000Z");
    const response = previewRenice(300, 10, TREE, OMNI_PID);
    if (response.status !== "ready") throw new Error("expected a ready preview");

    const applied = await reniceProcess(
      response.plan as Extract<ActivityPlan, { kind: "renice-process" }>,
      now,
      store,
      platform,
    );

    expect(applied.status).toBe("applied");
    expect(applied.receipt).toMatchObject({ kind: "renice-process", status: "applied", nice: 10 });
    expect(calls).toEqual(
      expect.arrayContaining([
        { pid: 300, nice: 10 },
        { pid: 301, nice: 10 },
        { pid: 302, nice: 10 },
      ]),
    );
  });
});
