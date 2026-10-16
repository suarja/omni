// POSIX pieces shared by every Unix-like `Platform` implementation (darwin today, linux when
// it lands): signalling, liveness, and the generic `ps` invocation. What differs per platform
// (the BSD column names darwin asks `ps` for, `lsof` for working directories) stays out of
// this file and lives in the platform module itself.
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import type { PlatformSignal } from "./platform";

const execFile = promisify(nodeExecFile);

const SIGNAL_BY_ACTION: Readonly<Record<PlatformSignal, NodeJS.Signals>> = {
  stop: "SIGTERM",
  kill: "SIGKILL",
  pause: "SIGSTOP",
  resume: "SIGCONT",
};

export async function posixSignal(pid: number, action: PlatformSignal): Promise<void> {
  process.kill(pid, SIGNAL_BY_ACTION[action]);
}

// Signal 0 sends nothing; it only probes whether the process still exists and is ours to
// signal. This is the same check `waitForExit` used inline before the seam existed.
export function posixIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function invokePs(args: readonly string[]): Promise<string> {
  const result = await execFile("ps", [...args], { shell: false, timeout: 1_500, windowsHide: true });
  return result.stdout;
}
