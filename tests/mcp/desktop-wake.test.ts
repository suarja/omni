import { afterEach, expect, it, vi } from "vitest";
import { createDesktopWake, withDesktopWake } from "../../packages/omni-mcp/src/desktop-wake";
import type { GatewayResult } from "../../packages/omni-mcp/src/gateway-client";
const unavailable: GatewayResult = {
  ok: false,
  unavailable: { status: "app-not-running", message: "Open Omni Desktop to use the Omni tools." },
};
afterEach(() => vi.useRealTimers());
function fixture(patch = {}) {
  let ready = false;
  const findInstalledApp = vi.fn(async () => "/Applications/Omni Desktop.app");
  const launch = vi.fn(async (_appPath: string, _signal: AbortSignal) => {
    ready = true;
  });
  const probe = vi.fn(async () => ready);
  const request = vi.fn(async (): Promise<GatewayResult> =>
    ready ? { ok: true, result: { status: "ready" } } : unavailable,
  );
  const wake = createDesktopWake({
    profileOverridden: false,
    platform: "darwin",
    findInstalledApp,
    launch,
    probe,
    ...patch,
  });
  return {
    findInstalledApp,
    launch,
    probe,
    request,
    client: withDesktopWake({ request, close: async () => {} }, wake),
  };
}
it("opens an installed Desktop in the background, waits for its socket and retries once", async () => {
  const f = fixture();
  expect(await f.client.request("status", {})).toEqual({ ok: true, result: { status: "ready" } });
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.launch.mock.calls[0]![0]).toBe("/Applications/Omni Desktop.app");
  expect(f.request).toHaveBeenCalledTimes(2);
});
it.each([{ profileOverridden: true }, { platform: "linux" }])(
  "never auto-opens an ineligible runtime %j",
  async (patch) => {
    const f = fixture(patch);
    expect(await f.client.request("status", {})).toEqual(unavailable);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.findInstalledApp).not.toHaveBeenCalled();
  },
);
it("does not launch without a detected app", async () => {
  const launch = vi.fn();
  const f = fixture({ findInstalledApp: async () => undefined, launch });
  expect(await f.client.request("status", {})).toEqual(unavailable);
  expect(launch).not.toHaveBeenCalled();
});
it("shares one wake attempt across concurrent tool calls", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const launch = vi.fn(async () => launched);
  let ready = false;
  const f = fixture({ launch, probe: async () => ready });
  f.request.mockImplementation(async () => (ready ? { ok: true, result: { status: "ready" } } : unavailable));
  const calls = [f.client.request("status", {}), f.client.request("list_marketplace", {})];
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  ready = true;
  release();
  expect(await Promise.all(calls)).toEqual([
    { ok: true, result: { status: "ready" } },
    { ok: true, result: { status: "ready" } },
  ]);
  expect(launch).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledTimes(4);
});
it("reports a failed launch honestly and leaves the session able to reconnect", async () => {
  const f = fixture({
    launch: async () => {
      throw new Error("Launch refused");
    },
  });
  const result = await f.client.request("status", {});
  expect(result).toMatchObject({
    ok: false,
    unavailable: {
      status: "app-not-running",
      message: expect.stringMatching(/could not be opened.*this session reconnects by itself/i),
    },
  });
  expect(f.request).toHaveBeenCalledOnce();
});
it("bounds socket waiting at 20 seconds without retrying an unavailable gateway", async () => {
  vi.useFakeTimers();
  const launch = vi.fn(async () => {});
  const f = fixture({ launch, probe: async () => false });
  const result = f.client.request("status", {});
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toMatchObject({ ok: false, unavailable: { message: expect.stringContaining("20 seconds") } });
  expect(launch).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds a stuck launcher at the same 20 second deadline", async () => {
  vi.useFakeTimers();
  const f = fixture({ launch: () => new Promise<void>(() => {}) });
  const result = f.client.request("status", {});
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toMatchObject({ ok: false, unavailable: { message: expect.stringContaining("20 seconds") } });
  expect(vi.getTimerCount()).toBe(0);
});
it("retries only once even when the gateway remains unavailable after a successful probe", async () => {
  const f = fixture();
  f.request.mockResolvedValue(unavailable);
  expect(await f.client.request("status", {})).toEqual(unavailable);
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.launch).toHaveBeenCalledOnce();
});
it("does not wake for gateway errors or rejected authentication", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({ ok: false, error: { code: "denied", message: "Denied" } });
  await f.client.request("status", {});
  f.request.mockResolvedValueOnce({
    ok: false,
    unavailable: {
      status: "app-not-running",
      message: "Omni Desktop rejected the agent token. Open Omni Desktop to refresh access.",
    },
  });
  await f.client.request("status", {});
  expect(f.launch).not.toHaveBeenCalled();
});
