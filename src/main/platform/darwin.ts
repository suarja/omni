// The darwin `Platform`: today's macOS-only code, moved here rather than rewritten. Every
// function below is the exact behaviour `activity-snapshot.ts`, `activity-actions.ts` and
// `agent-gateway/server.ts` had before the platform seam — same `ps`/`lsof` invocations, same
// signals, same socket path rule.
import { execFile as nodeExecFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { parseLsofCwdOutput, parseLsofListenPorts, parsePsOutput } from "../activity-processes";
import { invokePs, posixIsAlive, posixSignal } from "./posix";
import type { ListeningPort, Platform, RawProcess } from "./platform";

const execFile = promisify(nodeExecFile);

// The BSD column set `ps` needs on darwin; everything else about invoking `ps` is shared POSIX
// plumbing in `posix.ts`. `stat` was added for Activity iteration 3 (D4): the first letter maps
// to a process's running/sleeping/stopped/zombie state.
const PS_ARGS = ["-Ao", "pid,ppid,pcpu,etime,lstart,rss,stat,args"] as const;

async function list(): Promise<readonly RawProcess[]> {
  return parsePsOutput(await invokePs(PS_ARGS));
}

async function runLsof(pids: readonly number[]): Promise<string> {
  const result = await execFile("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
    shell: false,
    timeout: 1_500,
    windowsHide: true,
  });
  return result.stdout;
}

async function workingDirectories(pids: readonly number[]): Promise<ReadonlyMap<number, string>> {
  if (!pids.length) return new Map();
  try {
    return parseLsofCwdOutput(await runLsof(pids));
  } catch {
    return new Map();
  }
}

async function openTerminal(cwd: string): Promise<void> {
  await execFile("open", ["-a", "Terminal", cwd], { shell: false, windowsHide: true });
}

// `-a` ANDs the selectors (without it lsof ORs `-i` and `-p` and lists every listening socket on
// the machine); `-P -n` keep port numbers and hostnames unresolved (fast, no DNS/service lookups);
// `-sTCP:LISTEN` filters to listening sockets only, which is all "what port is this agent serving" needs.
async function listeningPorts(pids: readonly number[]): Promise<readonly ListeningPort[]> {
  if (!pids.length) return [];
  try {
    const result = await execFile("lsof", ["-a", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-p", pids.join(",")], {
      shell: false,
      windowsHide: true,
    });
    return parseLsofListenPorts(result.stdout);
  } catch {
    // No matching process is listening (lsof exits non-zero for "nothing found"), or lsof is
    // unavailable: an honest empty result either way.
    return [];
  }
}

async function renice(pid: number, nice: number): Promise<void> {
  await execFile("renice", ["-n", String(nice), "-p", String(pid)], { shell: false, windowsHide: true });
}

// The socket lives under the app's own user data directory; this is the address the desktop
// app reports and the address the `omni-mcp` client (a separate process) independently
// computes with the same formula. `agent-gateway/server.ts` still falls back to a shorter
// path under `tmpdir()` when this one would exceed the AF_UNIX length limit, symlinking this
// canonical path to it so callers keep finding the socket here either way.
function endpoint(userDataPath: string): string {
  return resolve(userDataPath, "omni", "agent.sock");
}

async function secure(path: string): Promise<void> {
  // Only this user may connect; the agent token is the second lock.
  await chmod(path, 0o600);
}

export function createDarwinPlatform(): Platform {
  return {
    id: "darwin",
    supported: true,
    processes: {
      list,
      workingDirectories,
      signal: posixSignal,
      isAlive: posixIsAlive,
      listeningPorts,
      renice,
    },
    terminal: { open: openTerminal },
    gateway: { endpoint, secure },
  };
}
