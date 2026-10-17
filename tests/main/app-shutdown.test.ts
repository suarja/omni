import { EventEmitter, once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createAppShutdown } from "../../src/main/app-shutdown";

function fixture() {
  const app = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const killChildren = vi.fn();
  const report = vi.fn();
  const shutdown = createAppShutdown({ app, killChildren, report });
  return { app, shutdown, killChildren, report };
}
afterEach(() => vi.useRealTimers());
it("runs cleanup once and ends the main process for menu Quit, Cmd+Q and Apple events", async () => {
  const f = fixture();
  let finish!: () => void;
  const cleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  f.shutdown.addCleanup("gateway", cleanup);
  const event = { preventDefault: vi.fn() };
  f.app.emit("before-quit", event);
  f.app.emit("before-quit", event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(f.app.exit).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(0));
  expect(f.killChildren).toHaveBeenCalledOnce();
});
it("bounds a stuck cleanup to three seconds and reports the unfinished operation", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.shutdown.addCleanup("directory reader", () => new Promise(() => {}));
  f.app.emit("before-quit", { preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.app.exit).toHaveBeenCalledWith(0);
  expect(f.killChildren).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledWith(expect.stringContaining("directory reader"), expect.anything());
});
it("cleans up before Squirrel termination and never cancels its before-quit", async () => {
  const f = fixture();
  const order: string[] = [];
  f.shutdown.addCleanup("reader", () => {
    order.push("cleanup");
  });
  await f.shutdown.prepareForUpdate();
  order.push("Squirrel relaunch request");
  const event = { preventDefault: vi.fn() };
  f.app.emit("before-quit", event);
  expect(order).toEqual(["cleanup", "Squirrel relaunch request"]);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(f.app.exit).not.toHaveBeenCalled();
  expect(f.shutdown.isQuitting()).toBe(true);
});
it("continues other cleanups after a synchronous throw or rejection", async () => {
  const f = fixture();
  f.shutdown.addCleanup("watcher", () => {
    throw new Error("watcher failed");
  });
  f.shutdown.addCleanup("gateway", async () => {
    throw new Error("gateway failed");
  });
  const reader = vi.fn();
  f.shutdown.addCleanup("reader", reader);
  await f.shutdown.prepareForUpdate();
  expect(reader).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledTimes(2);
  expect(f.killChildren).toHaveBeenCalledOnce();
});
it("does not quit when the last window closes", () => {
  const f = fixture();
  f.app.emit("window-all-closed");
  expect(f.shutdown.isQuitting()).toBe(false);
  expect(f.app.exit).not.toHaveBeenCalled();
});

it("disconnects authenticated agents before completing an explicit Quit", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAgentGateway } = await import("../../src/main/agent-gateway/server");
  const { connect, hello } = await import("./agent-gateway-helpers");
  const root = await mkdtemp(join(tmpdir(), "omni-shutdown-test-"));
  const gateway = createAgentGateway({ userDataPath: root, router: { handle: async () => ({ status: "ready" }) } });
  try {
    await gateway.start();
    const client = await connect(gateway.socketPath);
    expect(await hello(client, await gateway.tokenManager.ensure())).toMatchObject({ result: { status: "ready" } });
    const closed = once(client, "close");
    const f = fixture();
    f.shutdown.addCleanup("gateway", () => gateway.stop());
    f.app.emit("before-quit", { preventDefault: vi.fn() });
    await closed;
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(0));
    expect(client.destroyed).toBe(true);
  } finally {
    await gateway.stop();
    await rm(root, { recursive: true, force: true });
  }
});
