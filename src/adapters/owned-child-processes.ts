import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
export type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";

const children = new Set<ChildProcess>();
let quitting = false;
function assertRunning(): void {
  if (quitting) throw new Error("Cannot start a child process: Omni is quitting. Reopen Omni to retry.");
}
function own<T extends ChildProcess>(child: T): T {
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

// Keep Node's overloads and promisified .child contract at this process adapter boundary.
export const spawn: typeof nodeSpawn = ((...args: Parameters<typeof nodeSpawn>) => {
  assertRunning();
  return own(nodeSpawn(...args));
}) as typeof nodeSpawn;
export const execFile: typeof nodeExecFile = Object.assign(
  ((...args: Parameters<typeof nodeExecFile>) => {
    assertRunning();
    return own(nodeExecFile(...args));
  }) as typeof nodeExecFile,
  {
    [promisify.custom]: (...args: Parameters<typeof nodeExecFile.__promisify__>) => {
      assertRunning();
      const result = promisify(nodeExecFile)(...args);
      own(result.child);
      return result;
    },
  },
);

/** Only handles created by this main process are signalled, never discovered user processes. */
export function terminateOwnedChildren(): void {
  quitting = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      console.error("Could not terminate an Omni child process during quit.", error);
    }
  }
}
