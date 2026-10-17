import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.resetModules());
it("kills only Omni-owned children, including detached simulations and promisified commands", async () => {
  const { spawn, execFile, terminateOwnedChildren } = await import("../../src/adapters/owned-child-processes");
  const unrelated = nodeSpawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const command = promisify(execFile)(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const failed = command.catch((error: unknown) => error);
  const closed = once(child, "close");
  const commandClosed = once(command.child, "close");
  try {
    terminateOwnedChildren();
    await Promise.all([closed, commandClosed, failed]);
    expect(child.signalCode).toBe("SIGKILL");
    expect(command.child.signalCode).toBe("SIGKILL");
    expect(unrelated.signalCode).toBeNull();
    expect(() => spawn(process.execPath, ["-e", ""])).toThrow(/quitting/);
    expect(() => execFile(process.execPath, ["-e", ""])).toThrow(/quitting/);
  } finally {
    unrelated.kill("SIGKILL");
    child.kill("SIGKILL");
    command.child.kill("SIGKILL");
  }
});
it("preserves command output, callback behavior and the promisified child handle", async () => {
  const { execFile, terminateOwnedChildren } = await import("../../src/adapters/owned-child-processes");
  const pending = promisify(execFile)(process.execPath, ["-e", "process.stdout.write('ok')"]);
  expect(pending.child.pid).toBeGreaterThan(0);
  expect((await pending).stdout).toBe("ok");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["-e", "process.stdout.write('callback')"], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  expect(output).toBe("callback");
  terminateOwnedChildren();
  // The native adapter stays untouched for other callers and test processes.
  expect((await promisify(nodeExecFile)(process.execPath, ["-e", "process.stdout.write('native')"])).stdout).toBe(
    "native",
  );
});
