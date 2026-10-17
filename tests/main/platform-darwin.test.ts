import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDarwinPlatform } from "../../src/main/platform/darwin";

const FIXTURES = join(__dirname, "../fixtures/platform/darwin");

type ExecCall = Readonly<{ file: string; args: readonly string[]; timeout?: number }>;
type ExecResult = Readonly<{ stdout: string; stderr: string }>;

// These parsing tests stub the owned-process adapter's promisified command boundary.
// Child handle ownership is covered separately with real processes.
async function loadDarwin(handler: (call: ExecCall) => Promise<ExecResult>) {
  vi.resetModules();
  vi.doMock("../../src/adapters/owned-child-processes", () => {
    const execFile = (): void => {
      throw new Error("This stub only implements the promisified execFile path.");
    };
    (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
      file: string,
      args: readonly string[],
      options?: { timeout?: number },
    ) => handler({ file, args, ...(options?.timeout ? { timeout: options.timeout } : {}) });
    return { execFile };
  });
  return import("../../src/main/platform/darwin");
}

afterEach(() => {
  vi.doUnmock("../../src/adapters/owned-child-processes");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("darwin platform: identity and gateway", () => {
  it("reports its id, that it is supported, and the canonical gateway socket path", () => {
    const platform = createDarwinPlatform();
    expect(platform.id).toBe("darwin");
    expect(platform.supported).toBe(true);
    expect(platform.gateway.endpoint("/Users/example/Library/Application Support/omni-desktop")).toBe(
      "/Users/example/Library/Application Support/omni-desktop/omni/agent.sock",
    );
  });

  it("secures the socket file with chmod 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-darwin-secure-"));
    const file = join(dir, "agent.sock");
    await writeFile(file, "");
    try {
      await createDarwinPlatform().gateway.secure(file);
      const info = await stat(file);
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("darwin platform: processes (recorded ps/lsof fixtures)", () => {
  it("lists processes parsed from a recorded `ps -Ao ...` fixture", async () => {
    const psFixture = await readFile(join(FIXTURES, "ps.txt"), "utf8");
    const calls: ExecCall[] = [];
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async (call) => {
      calls.push(call);
      if (call.file === "ps") return { stdout: psFixture, stderr: "" };
      throw new Error(`Unexpected command in this test: ${call.file}`);
    });

    const processes = await createFromStub().processes.list();

    expect(calls).toEqual([{ file: "ps", args: ["-Ao", "pid,ppid,pcpu,etime,lstart,rss,stat,args"], timeout: 1_500 }]);
    // The header row and every other malformed line are dropped, not misparsed.
    expect(processes.length).toBe(psFixture.trim().split("\n").length - 1);
    expect(processes.find((process) => process.pid === 9792)).toMatchObject({
      ppid: 9775,
      command: expect.stringContaining("electron-vite"),
      state: "sleeping",
    });
    expect(processes.find((process) => process.pid === 30022)).toMatchObject({ command: "node -e omni-sim-runaway" });
    expect(processes.every((process) => Number.isFinite(process.cpuPercent) && Number.isFinite(process.rssMb))).toBe(
      true,
    );
  });

  it("maps the ps STAT column's first letter to running/sleeping/stopped/zombie/other", async () => {
    const output = [
      "    1     0   0.0       00:01 Mon Sep 14 00:00:00 2026        100 R+ node running",
      "    2     0   0.0       00:01 Mon Sep 14 00:00:00 2026        100 Ss node sleeping",
      "    3     0   0.0       00:01 Mon Sep 14 00:00:00 2026        100 T  node stopped",
      "    4     0   0.0       00:01 Mon Sep 14 00:00:00 2026        100 Z  node zombie",
      "    5     0   0.0       00:01 Mon Sep 14 00:00:00 2026        100 U  node other",
    ].join("\n");
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async () => ({ stdout: output, stderr: "" }));

    const processes = await createFromStub().processes.list();

    expect(processes.map((process) => process.state)).toEqual(["running", "sleeping", "stopped", "zombie", "other"]);
  });

  it("reads working directories parsed from a recorded `lsof -Fn` fixture", async () => {
    const lsofFixture = await readFile(join(FIXTURES, "lsof.txt"), "utf8");
    const calls: ExecCall[] = [];
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async (call) => {
      calls.push(call);
      if (call.file === "lsof") return { stdout: lsofFixture, stderr: "" };
      throw new Error(`Unexpected command in this test: ${call.file}`);
    });

    const cwds = await createFromStub().processes.workingDirectories([9775, 9792, 30021, 60013]);

    expect(calls).toEqual([
      { file: "lsof", args: ["-a", "-p", "9775,9792,30021,60013", "-d", "cwd", "-Fn"], timeout: 1_500 },
    ]);
    expect(cwds.get(9775)).toBe("/Users/example/App/project-b");
    expect(cwds.get(9792)).toBe("/Users/example/App/project-b");
    expect(cwds.get(30021)).toBe("/Users/example/App/project-d");
    // A pid `lsof` never mentions (already exited, or not in the fixture) is simply absent.
    expect(cwds.has(60013)).toBe(false);
  });

  it("returns an empty map without invoking lsof when there are no pids", async () => {
    const calls: ExecCall[] = [];
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async (call) => {
      calls.push(call);
      return { stdout: "", stderr: "" };
    });

    const cwds = await createFromStub().processes.workingDirectories([]);

    expect(cwds.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("returns an empty map instead of throwing when lsof fails", async () => {
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async () => {
      throw new Error("lsof: exit status 1");
    });

    await expect(createFromStub().processes.workingDirectories([1])).resolves.toEqual(new Map());
  });
});

describe("darwin platform: terminal", () => {
  it("opens Terminal via `open -a Terminal <cwd>` with no shell", async () => {
    const calls: ExecCall[] = [];
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async (call) => {
      calls.push(call);
      return { stdout: "", stderr: "" };
    });

    await createFromStub().terminal.open("/Users/example/App/project-b");

    expect(calls).toEqual([{ file: "open", args: ["-a", "Terminal", "/Users/example/App/project-b"] }]);
  });
});

describe("darwin platform: listening ports (recorded lsof -iTCP fixture)", () => {
  it("parses pid/port pairs from a recorded `lsof -iTCP -sTCP:LISTEN` fixture", async () => {
    const fixture = await readFile(join(FIXTURES, "lsof-listen.txt"), "utf8");
    const calls: ExecCall[] = [];
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async (call) => {
      calls.push(call);
      if (call.file === "lsof") return { stdout: fixture, stderr: "" };
      throw new Error(`Unexpected command in this test: ${call.file}`);
    });

    const ports = await createFromStub().processes.listeningPorts([9792, 16040]);

    expect(calls).toEqual([{ file: "lsof", args: ["-a", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-p", "9792,16040"] }]);
    expect(ports).toEqual(
      expect.arrayContaining([
        { pid: 9792, port: 3000 },
        { pid: 9792, port: 9334 },
        { pid: 16040, port: 51204 },
      ]),
    );
  });

  it("returns an empty array without invoking lsof when there are no pids", async () => {
    const calls: ExecCall[] = [];
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async (call) => {
      calls.push(call);
      return { stdout: "", stderr: "" };
    });

    expect(await createFromStub().processes.listeningPorts([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("returns an empty array instead of throwing when lsof finds nothing (non-zero exit)", async () => {
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async () => {
      throw new Error("lsof: exit status 1");
    });

    await expect(createFromStub().processes.listeningPorts([1])).resolves.toEqual([]);
  });
});

describe("darwin platform: renice", () => {
  it("runs `renice -n <nice> -p <pid>` with no shell", async () => {
    const calls: ExecCall[] = [];
    const { createDarwinPlatform: createFromStub } = await loadDarwin(async (call) => {
      calls.push(call);
      return { stdout: "", stderr: "" };
    });

    await createFromStub().processes.renice(4242, 10);
    await createFromStub().processes.renice(4242, 0);

    expect(calls).toEqual([
      { file: "renice", args: ["-n", "10", "-p", "4242"] },
      { file: "renice", args: ["-n", "0", "-p", "4242"] },
    ]);
  });
});

describe("darwin platform: signalling", () => {
  it("maps every platform signal to the POSIX signal `process.kill` receives", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const platform = createDarwinPlatform();

    void platform.processes.signal(4242, "stop");
    void platform.processes.signal(4242, "kill");
    void platform.processes.signal(4242, "pause");
    void platform.processes.signal(4242, "resume");

    expect(spy.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL", "SIGSTOP", "SIGCONT"]);
  });

  it("probes liveness with signal 0 and reports honestly either way", () => {
    const spy = vi.spyOn(process, "kill");
    const platform = createDarwinPlatform();

    spy.mockImplementationOnce(() => true);
    expect(platform.processes.isAlive(4242)).toBe(true);

    spy.mockImplementationOnce(() => {
      throw new Error("kill ESRCH");
    });
    expect(platform.processes.isAlive(999_999)).toBe(false);
  });
});
