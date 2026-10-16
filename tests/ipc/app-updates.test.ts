import { afterEach, expect, it, vi } from "vitest";
import { APP_UPDATE_CHANNELS, parseAppUpdateState, parseUpdateEnabled } from "../../src/shared/app-updates-ipc";
import type { AppUpdatesService } from "../../src/main/app-updates/service";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
});
it("rejects malformed preferences and update state at the IPC boundary", () => {
  expect(parseUpdateEnabled({ enabled: false })).toBe(false);
  for (const value of [null, [], {}, { enabled: "yes" }, { enabled: true, other: false }])
    expect(() => parseUpdateEnabled(value)).toThrow();
  for (const value of [null, {}, { available: true, enabled: true, downloaded: false, error: false, other: 1 }])
    expect(() => parseAppUpdateState(value)).toThrow();
});
it("guards the sender and validates every request before reading or restarting updates", async () => {
  const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>();
  vi.doMock("electron", () => ({
    ipcMain: {
      handle: (name: string, handler: (event: unknown, value: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
    },
  }));
  const { registerAppUpdatesIpc } = await import("../../src/main/app-updates/ipc");
  const state = { available: true, enabled: true, downloaded: false, error: false };
  const service: AppUpdatesService = {
    initialize: async () => {},
    dispose: () => {},
    get: vi.fn(async () => state),
    set: vi.fn(async () => state),
    restart: vi.fn(async () => {}),
  };
  registerAppUpdatesIpc((event) => {
    if (!event) throw new Error("Untrusted sender");
  }, service);
  await expect(handlers.get(APP_UPDATE_CHANNELS.restart)!(false, {})).rejects.toThrow("Untrusted");
  await expect(handlers.get(APP_UPDATE_CHANNELS.restart)!(true, { command: "anything" })).rejects.toThrow();
  await expect(handlers.get(APP_UPDATE_CHANNELS.get)!(true, { other: true })).rejects.toThrow();
  await expect(handlers.get(APP_UPDATE_CHANNELS.set)!(true, { enabled: "yes" })).rejects.toThrow();
  expect(service.get).not.toHaveBeenCalled();
  expect(service.set).not.toHaveBeenCalled();
  expect(service.restart).not.toHaveBeenCalled();
  await expect(handlers.get(APP_UPDATE_CHANNELS.set)!(true, { enabled: false })).resolves.toEqual(state);
  await handlers.get(APP_UPDATE_CHANNELS.restart)!(true, {});
  expect(service.set).toHaveBeenCalledExactlyOnceWith(false);
  expect(service.restart).toHaveBeenCalledOnce();
});
it("validates preload responses and ignores malformed update events", async () => {
  const invoke = vi.fn(async () => ({ available: true, enabled: true, downloaded: false, error: false }));
  let receive: ((event: unknown, raw: unknown) => void) | undefined;
  const removeListener = vi.fn();
  vi.doMock("electron", () => ({
    ipcRenderer: {
      invoke,
      on: (_channel: string, listener: typeof receive) => {
        receive = listener;
      },
      removeListener,
    },
  }));
  const { createAppUpdatesDesktopApi } = await import("../../src/preload/app-updates");
  const api = createAppUpdatesDesktopApi();
  await expect(api.setAppUpdates({ enabled: "yes" } as never)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  await expect(api.getAppUpdates()).resolves.toMatchObject({ enabled: true });
  invoke.mockResolvedValueOnce({ enabled: true } as never);
  await expect(api.getAppUpdates()).rejects.toThrow();
  const listener = vi.fn();
  const stop = api.onAppUpdatesChanged(listener);
  receive?.({}, { enabled: true });
  expect(listener).not.toHaveBeenCalled();
  const state = { available: true, enabled: true, downloaded: true, error: false };
  receive?.({}, state);
  expect(listener).toHaveBeenCalledExactlyOnceWith(state);
  stop();
  expect(removeListener).toHaveBeenCalledOnce();
});
