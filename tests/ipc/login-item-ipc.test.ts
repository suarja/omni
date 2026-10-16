import { afterEach, expect, it, vi } from "vitest";
import { LOGIN_ITEM_CHANNELS, parseLoginItemSetRequest, parseLoginItemState } from "../../src/shared/login-item-ipc";
import type { LoginItemService } from "../../src/main/login-item";
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
});
it("rejects malformed toggles and OS-state payloads", () => {
  expect(parseLoginItemSetRequest({ openAtLogin: false })).toEqual({ openAtLogin: false });
  for (const value of [null, [], {}, { openAtLogin: "yes" }, { openAtLogin: true, other: true }])
    expect(() => parseLoginItemSetRequest(value)).toThrow();
  for (const value of [
    null,
    [],
    {},
    { available: true, openAtLogin: "yes", status: "enabled" },
    { available: true, openAtLogin: true, status: "enabled", other: true },
  ])
    expect(() => parseLoginItemState(value)).toThrow();
});
it("guards the sender and parses the request before accessing login items", async () => {
  const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
  vi.doMock("electron", () => ({
    ipcMain: {
      handle: (name: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
    },
  }));
  const { registerLoginItemIpcHandlers } = await import("../../src/main/login-item-ipc");
  const state = { available: true, openAtLogin: false, status: "not-registered" };
  const service: LoginItemService = {
    initialize: async () => {},
    get: vi.fn(async () => state),
    set: vi.fn(async () => state),
    wasOpenedAtLogin: () => false,
  };
  registerLoginItemIpcHandlers((event) => {
    if (!event) throw new Error("Untrusted sender");
  }, service);
  await expect(handlers.get(LOGIN_ITEM_CHANNELS.set)!(false, { openAtLogin: true })).rejects.toThrow("Untrusted");
  await expect(handlers.get(LOGIN_ITEM_CHANNELS.set)!(true, { openAtLogin: "yes" })).rejects.toThrow();
  await expect(handlers.get(LOGIN_ITEM_CHANNELS.get)!(true, { other: true })).rejects.toThrow();
  expect(service.get).not.toHaveBeenCalled();
  expect(service.set).not.toHaveBeenCalled();
  await expect(handlers.get(LOGIN_ITEM_CHANNELS.get)!(true, {})).resolves.toEqual(state);
  await expect(handlers.get(LOGIN_ITEM_CHANNELS.set)!(true, { openAtLogin: false })).resolves.toEqual(state);
  expect(service.set).toHaveBeenCalledExactlyOnceWith(false);
});
it("validates the toggle before preload IPC and validates its returned OS state", async () => {
  const expose = vi.fn();
  const invoke = vi.fn(async () => ({ available: true, openAtLogin: false, status: "not-registered" }));
  vi.doMock("electron", () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }));
  await import("../../src/preload/index");
  const api = expose.mock.calls[0]![1] as import("../../src/shared/ipc").DesktopApi;
  await expect(api.setLoginItem!({ openAtLogin: "yes" } as never)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  await expect(api.getLoginItem!()).resolves.toMatchObject({ openAtLogin: false });
  expect(invoke).toHaveBeenLastCalledWith(LOGIN_ITEM_CHANNELS.get, {});
  await api.setLoginItem!({ openAtLogin: true });
  expect(invoke).toHaveBeenLastCalledWith(LOGIN_ITEM_CHANNELS.set, { openAtLogin: true });
  invoke.mockResolvedValueOnce({ available: true, openAtLogin: "bad", status: "enabled" } as never);
  await expect(api.getLoginItem!()).rejects.toThrow();
});
