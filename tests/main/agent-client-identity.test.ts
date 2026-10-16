import { describe, expect, it, vi } from "vitest";

import { createAgentClientIdentityResolver } from "../../src/main/agent-client-identity";
import { createPlatformStub } from "./platform-stub";

describe("agent client identity", () => {
  it("uses one process listing and queries cwd only for the requested verified ancestry", async () => {
    const fixture = [
      { pid: 100, ppid: 1, cpuPercent: 0, elapsedSeconds: 1, rssMb: 1, command: "/usr/local/bin/claude --print" },
      { pid: 102, ppid: 100, cpuPercent: 0, elapsedSeconds: 1, rssMb: 1, command: "node helper.js" },
      { pid: 101, ppid: 102, cpuPercent: 0, elapsedSeconds: 1, rssMb: 1, command: "node helper.js" },
      { pid: 200, ppid: 1, cpuPercent: 0, elapsedSeconds: 1, rssMb: 1, command: "codex app-server" },
    ];
    const list = vi.fn(async () => fixture);
    const workingDirectories = vi.fn(
      async (pids: readonly number[]) => new Map(pids.map((pid) => [pid, `/fixture/${pid}`])),
    );
    const platform = createPlatformStub({
      processes: fixture,
    });
    const resolver = createAgentClientIdentityResolver({
      platform: {
        ...platform,
        processes: { ...platform.processes, list, workingDirectories },
      },
      omniPid: 999,
    });

    const [first, second] = await Promise.all([
      resolver({ pid: 101, name: "client", version: "1" }),
      resolver({ pid: 101, name: "client", version: "1" }),
    ]);

    expect(list).toHaveBeenCalledTimes(1);
    expect(workingDirectories).toHaveBeenCalledTimes(1);
    expect(workingDirectories).toHaveBeenCalledWith([101, 100]);
    expect(first).toEqual({ harness: "claude-code", cwd: "/fixture/101" });
    expect(second).toEqual(first);
  });

  it("rejects a cyclic PID chain without querying cwd", async () => {
    const processes = [
      { pid: 101, ppid: 102, cpuPercent: 0, elapsedSeconds: 1, rssMb: 1, command: "node helper.js" },
      { pid: 102, ppid: 101, cpuPercent: 0, elapsedSeconds: 1, rssMb: 1, command: "node helper.js" },
    ];
    const workingDirectories = vi.fn(async () => new Map<number, string>());
    const platform = createPlatformStub({ processes });
    const resolver = createAgentClientIdentityResolver({
      platform: { ...platform, processes: { ...platform.processes, workingDirectories } },
      omniPid: 999,
    });

    await expect(resolver({ pid: 101, name: "client", version: "1" })).resolves.toEqual({});
    expect(workingDirectories).not.toHaveBeenCalled();
  });

  it("rejects a process that exited before cwd attribution", async () => {
    const processes = [
      { pid: 101, ppid: 100, cpuPercent: 0, elapsedSeconds: 1, rssMb: 1, command: "node helper.js" },
      { pid: 100, ppid: 1, cpuPercent: 0, elapsedSeconds: 1, rssMb: 1, command: "/usr/local/bin/claude --print" },
    ];
    const workingDirectories = vi.fn(async () => new Map<number, string>());
    const platform = createPlatformStub({ processes, alivePids: new Set([100]) });
    const resolver = createAgentClientIdentityResolver({
      platform: { ...platform, processes: { ...platform.processes, workingDirectories } },
      omniPid: 999,
    });

    await expect(resolver({ pid: 101, name: "client", version: "1" })).resolves.toEqual({});
    expect(workingDirectories).not.toHaveBeenCalled();
  });

  it("stops ancestry traversal at the configured depth", async () => {
    const processes = Array.from({ length: 65 }, (_, index) => ({
      pid: index + 1,
      ppid: index + 2,
      cpuPercent: 0,
      elapsedSeconds: 1,
      rssMb: 1,
      command: "node helper.js",
    }));
    const workingDirectories = vi.fn(async () => new Map<number, string>());
    const platform = createPlatformStub({ processes });
    const resolver = createAgentClientIdentityResolver({
      platform: { ...platform, processes: { ...platform.processes, workingDirectories } },
      omniPid: 999,
    });

    await expect(resolver({ pid: 1, name: "client", version: "1" })).resolves.toEqual({});
    expect(workingDirectories).not.toHaveBeenCalled();
  });
});
