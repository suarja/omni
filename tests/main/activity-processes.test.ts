import { describe, expect, it } from "vitest";

import { attributeProcesses, parsePsOutput, type PsProcess } from "../../src/main/activity-processes";
import { PROCESS_FULL_COMMAND_MAX_LENGTH } from "../../src/shared/activity-ipc";

describe("activity process attribution", () => {
  it("attributes a Codex runner subtree and flags duplicate runaway leaves", () => {
    const output = [
      "  101     1   0.1 01:00:00 100000 codex exec --brief 15",
      "  102   101  95.0   08:00 200000 node (vitest)",
      "  103   102  95.1   08:00  50000 node (vitest 1)",
      "  104   102  95.2   08:00  50000 node (vitest 1)",
      "  105   102  95.3   08:00  50000 node (vitest 1)",
      "  106   102  95.4   08:00  50000 node (vitest 1)",
    ].join("\n");

    const processes = attributeProcesses(parsePsOutput(output), 999);

    expect(processes).toHaveLength(6);
    expect(processes[0]).toMatchObject({ pid: 101, agent: "codex", depth: 0, flags: [] });
    expect(processes[0]?.cpuPercent).toBe(0.1);
    expect(processes.slice(2).every((process) => process.agent === "codex" && process.depth === 2)).toBe(true);
    expect(
      processes.slice(2).every((process) => process.flags.includes("runaway") && process.flags.includes("duplicate")),
    ).toBe(true);
  });

  it("excludes the Codex desktop app tree while keeping the Codex CLI tree", () => {
    const processes: PsProcess[] = [
      {
        pid: 200,
        ppid: 1,
        cpuPercent: 0,
        elapsedSeconds: 1,
        rssMb: 10,
        command: "/Applications/Codex.app/Contents/MacOS/Codex",
      },
      {
        pid: 201,
        ppid: 200,
        cpuPercent: 0,
        elapsedSeconds: 1,
        rssMb: 10,
        command:
          "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex Helper (Renderer) --type=renderer",
      },
      { pid: 202, ppid: 201, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "browser_crashpad_handler" },
      { pid: 203, ppid: 200, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "Codex (Service)" },
      { pid: 204, ppid: 200, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "Electron --type=gpu-process" },
      { pid: 205, ppid: 1, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "codex exec --brief 16" },
      { pid: 206, ppid: 205, cpuPercent: 8.899999999999999, elapsedSeconds: 1, rssMb: 10, command: "node (vitest)" },
      { pid: 207, ppid: 206, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "node (vitest 1)" },
      { pid: 208, ppid: 206, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "node (vitest 1)" },
      { pid: 209, ppid: 206, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "node (vitest 1)" },
      { pid: 210, ppid: 206, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "node (vitest 1)" },
    ];

    const attributed = attributeProcesses(processes, 999);

    expect(attributed.map((process) => process.pid)).toEqual([205, 206, 207, 208, 209, 210]);
    expect(attributed.find((process) => process.pid === 206)).toMatchObject({
      command: "node (vitest)",
      cpuPercent: 8.9,
    });
  });

  it("does not duplicate runner flags for server-like commands or helpers", () => {
    const processes: PsProcess[] = [
      { pid: 300, ppid: 1, cpuPercent: 0, elapsedSeconds: 1, rssMb: 10, command: "codex exec" },
      { pid: 301, ppid: 300, cpuPercent: 1, elapsedSeconds: 1, rssMb: 10, command: "node server.js" },
      { pid: 302, ppid: 300, cpuPercent: 1, elapsedSeconds: 1, rssMb: 10, command: "node Helper" },
      { pid: 303, ppid: 300, cpuPercent: 1, elapsedSeconds: 1, rssMb: 10, command: "npm run dev" },
    ];

    const attributed = attributeProcesses(processes, 999);

    expect(attributed).toHaveLength(3);
    expect(attributed.every((process) => !process.flags.includes("duplicate"))).toBe(true);
  });

  it("keeps desktop-hosted Claude sessions, hides the disclaimer wrapper, and propagates a session id", () => {
    const processes: PsProcess[] = [
      {
        pid: 400,
        ppid: 1,
        cpuPercent: 0,
        elapsedSeconds: 1,
        rssMb: 10,
        command:
          "/Applications/Claude.app/Contents/Helpers/disclaimer -- /Users/example/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude --output-format stream-json --verbose",
      },
      {
        pid: 401,
        ppid: 400,
        cpuPercent: 1,
        elapsedSeconds: 1,
        rssMb: 20,
        command:
          "/Users/example/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude --output-format stream-json --verbose",
      },
      { pid: 402, ppid: 401, cpuPercent: 2, elapsedSeconds: 1, rssMb: 30, command: "node task.js" },
    ];

    const attributed = attributeProcesses(processes, 999, {
      rootSessionIds: new Map([[401, "claude-code:session-1"]]),
    });

    expect(attributed.map((process) => process.pid)).toEqual([401, 402]);
    expect(attributed.every((process) => process.sessionId === "claude-code:session-1")).toBe(true);
    expect(attributed[0]).toMatchObject({ name: "Claude Code session" });
  });

  it("bounds a process launched with a whole prompt as its argument so the snapshot still parses", () => {
    const prompt = "x".repeat(PROCESS_FULL_COMMAND_MAX_LENGTH * 3);
    const processes: PsProcess[] = [
      { pid: 500, ppid: 1, cpuPercent: 1, elapsedSeconds: 1, rssMb: 10, command: `codex exec --model luna ${prompt}` },
    ];

    const [attributed] = attributeProcesses(processes, 999);

    expect(attributed?.fullCommand).toHaveLength(PROCESS_FULL_COMMAND_MAX_LENGTH);
    expect(attributed?.fullCommand?.endsWith("…")).toBe(true);
    expect(attributed?.fullCommand?.startsWith("codex exec --model luna")).toBe(true);
  });
});
