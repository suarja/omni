import { defaultUnavailableMessage, type GatewayClientLike, type GatewayResult } from "./gateway-client.js";

type WakeOutcome = "ready" | "not-attempted" | "launch-failed" | "timeout";
export type DesktopWake = Readonly<{ wake(): Promise<WakeOutcome> }>;
export type DesktopWakeOptions = Readonly<{
  profileOverridden: boolean;
  platform: string;
  findInstalledApp(): Promise<string | undefined>;
  launch(appPath: string, signal: AbortSignal): Promise<void>;
  probe(signal: AbortSignal): Promise<boolean>;
}>;
const WAKE_BUDGET_MS = 20_000;
const POLL_INTERVAL_MS = 250;
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, POLL_INTERVAL_MS);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
async function tryWake(options: DesktopWakeOptions, signal: AbortSignal): Promise<WakeOutcome> {
  const appPath = await options.findInstalledApp();
  if (!appPath || signal.aborted) return "not-attempted";
  // A live socket with unavailable credentials needs access recovery, not another app launch.
  if (await options.probe(signal)) return "not-attempted";
  if (signal.aborted) return "timeout";
  try {
    await options.launch(appPath, signal);
  } catch {
    return signal.aborted ? "timeout" : "launch-failed";
  }
  while (!signal.aborted) {
    if (await options.probe(signal)) return "ready";
    await pause(signal);
  }
  return "timeout";
}
export function createDesktopWake(options: DesktopWakeOptions): DesktopWake {
  let inFlight: Promise<WakeOutcome> | undefined;
  return {
    wake: () => {
      if (options.profileOverridden || options.platform !== "darwin") return Promise.resolve("not-attempted");
      if (inFlight) return inFlight;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<WakeOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("timeout");
        }, WAKE_BUDGET_MS);
      });
      inFlight = Promise.race([
        tryWake(options, controller.signal).catch(() => "launch-failed" as const),
        timeout,
      ]).finally(() => {
        clearTimeout(timer);
        controller.abort();
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
function wakeFailure(result: GatewayResult, outcome: WakeOutcome): GatewayResult {
  if (outcome === "not-attempted") return result;
  const message =
    outcome === "timeout"
      ? "Omni Desktop did not become reachable within 20 seconds. Open Omni Desktop; this session reconnects by itself."
      : "Omni Desktop could not be opened in the background. Open Omni Desktop; this session reconnects by itself.";
  return { ok: false, unavailable: { status: "app-not-running", message } };
}
export function withDesktopWake(client: GatewayClientLike, wake: DesktopWake): GatewayClientLike {
  return {
    request: async (method, params) => {
      const result = await client.request(method, params);
      if (result.ok || !("unavailable" in result) || result.unavailable.message !== defaultUnavailableMessage())
        return result;
      const outcome = await wake.wake();
      return outcome === "ready" ? client.request(method, params) : wakeFailure(result, outcome);
    },
    close: () => client.close(),
  };
}
