import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { inspectBootstrapStatus } from "./bootstrap-status.js";
import {
  createGatewayClient,
  defaultUserDataPath,
  type GatewayClientLike,
  type GatewayClientOptions,
} from "./gateway-client.js";
import { createDesktopWake, withDesktopWake } from "./desktop-wake.js";

export function isDefaultWakeProfile(
  options: Readonly<{ target: string; standard: string; environment?: string }>,
): boolean {
  const standard = resolve(options.standard);
  return (
    resolve(options.target) === standard &&
    (options.environment === undefined || resolve(options.environment) === standard)
  );
}
export function launchDesktopInBackground(appPath: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile("open", ["-g", "-a", appPath], { signal, timeout: 20_000 }, (error) =>
      error ? reject(error) : resolvePromise(),
    );
  });
}
export async function probeDesktopSocket(socketPath: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const target = await realpath(socketPath).catch(() => undefined);
  if (!target || signal.aborted) return false;
  return new Promise((resolvePromise) => {
    const socket = net.createConnection(target);
    const finish = (ready: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolvePromise(ready);
    };
    const abort = (): void => finish(false);
    const timer = setTimeout(abort, 250);
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    if (signal.aborted) abort();
  });
}
export function createWakingGatewayClient(options: GatewayClientOptions = {}): GatewayClientLike {
  const standard = defaultUserDataPath();
  const profile = options.userDataPath ?? process.env.OMNI_USER_DATA ?? standard;
  const wake = createDesktopWake({
    profileOverridden: !isDefaultWakeProfile({ target: profile, standard, environment: process.env.OMNI_USER_DATA }),
    platform: process.platform,
    findInstalledApp: async () => {
      const status = await inspectBootstrapStatus({
        userDataPath: profile,
        desktopInstallPaths: [join("/Applications", "Omni.app"), join(homedir(), "Applications", "Omni.app")],
      });
      return status.desktop.appPath;
    },
    launch: launchDesktopInBackground,
    probe: (signal) => probeDesktopSocket(join(profile, "omni", "agent.sock"), signal),
  });
  return withDesktopWake(createGatewayClient({ ...options, userDataPath: profile }), wake);
}
