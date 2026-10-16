import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_LIBRARY_CHANNELS,
  parseExternalAddRequest,
  parseExternalLibraryList,
  parseExternalSourceRequest,
  parseExternalComparisonRequest,
} from "../../src/shared/external-library-ipc";
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
});
describe("external library IPC", () => {
  it("rejects renderer filesystem paths, extra fields, unsafe repositories and responses", () => {
    expect(parseExternalAddRequest({ repository: "https://github.com/A/B.git" })).toEqual({ repository: "a/b" });
    for (const input of [
      { repository: "/private/repo" },
      { repository: "a/b", path: "/private/data" },
      { repository: "https://secret@github.com/a/b" },
    ])
      expect(() => parseExternalAddRequest(input)).toThrow();
    expect(() => parseExternalSourceRequest({ sourceId: "../../private" })).toThrow();
    expect(() => parseExternalComparisonRequest({ useId: "a", sourceRoot: "/private/data" })).toThrow();
    expect(() =>
      parseExternalLibraryList({ sources: [], checking: false, diagnostics: [], absolutePath: "/private/data" }),
    ).toThrow();
  });
  it("guards every handler before parsing requests and dispatches only validated identities", async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
    vi.doMock("electron", () => ({
      ipcMain: { handle: (name: string, handler: never) => handlers.set(name, handler) },
    }));
    const list = vi.fn(async () => ({ sources: [], checking: false, diagnostics: [] }));
    const add = vi.fn(async () => ({ status: "added", skills: [], uses: [], marketplaceMatches: [] }));
    const readSource = vi.fn(async () => ({ skills: [], uses: [] }));
    const acknowledgeRemoved = vi.fn(async () => ({ skills: [], uses: [] }));
    const compare = vi.fn(async () => ({
      status: "unavailable",
      useId: "use",
      base: { status: "unknown", reason: "No base" },
      files: [],
    }));
    const onMac = vi.fn(async () => ({ status: "ready", marketplaces: [] }));
    const check = vi.fn(async () => ({
      startedAt: "2026-10-12T12:00:00.000Z",
      finishedAt: "2026-10-12T12:00:00.000Z",
      result: "success",
      errors: 0,
      diagnostics: [],
    }));
    const { registerExternalLibraryIpc } = await import("../../src/main/external-library/ipc");
    registerExternalLibraryIpc(
      (event) => {
        if (!event) throw new Error("Untrusted sender");
      },
      { list, add, readSource, compare, onMac, check, acknowledgeRemoved } as never,
    );
    expect(handlers.size).toBe(7);
    for (const handler of handlers.values()) await expect(handler(null, {})).rejects.toThrow(/Untrusted/u);
    await expect(
      handlers.get(EXTERNAL_LIBRARY_CHANNELS.add)!({}, { repository: "a/b", path: "/private/data" }),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
    await handlers.get(EXTERNAL_LIBRARY_CHANNELS.add)!({}, { repository: "https://github.com/A/B.git" });
    expect(add).toHaveBeenCalledWith("a/b");
    await handlers.get(EXTERNAL_LIBRARY_CHANNELS.source)!({}, { sourceId: "a/b" });
    expect(readSource).toHaveBeenCalledWith("a/b");
    await handlers.get(EXTERNAL_LIBRARY_CHANNELS.compare)!({}, { useId: "use" });
    expect(compare).toHaveBeenCalledWith("use");
    await handlers.get(EXTERNAL_LIBRARY_CHANNELS.acknowledge)!({}, { useId: "use" });
    expect(acknowledgeRemoved).toHaveBeenCalledWith("use");
    await handlers.get(EXTERNAL_LIBRARY_CHANNELS.onMac)!({}, {});
    expect(onMac).toHaveBeenCalledOnce();
    await handlers.get(EXTERNAL_LIBRARY_CHANNELS.check)!({}, {});
    expect(check).toHaveBeenCalledOnce();
    await expect(handlers.get(EXTERNAL_LIBRARY_CHANNELS.list)!({}, {})).resolves.toEqual({
      sources: [],
      checking: false,
      diagnostics: [],
    });
  });
  it("validates both directions in the sandboxed preload", async () => {
    const expose = vi.fn(),
      invoke = vi.fn(async () => ({ sources: [], checking: false, diagnostics: [] }));
    vi.doMock("electron", () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }));
    await import("../../src/preload/index");
    const api = expose.mock.calls[0]![1] as import("../../src/shared/external-library-ipc").ExternalLibraryDesktopApi;
    await expect(api.addExternalSource({ repository: "../bad" })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await expect(api.listExternalSources()).resolves.toEqual({ sources: [], checking: false, diagnostics: [] });
    expect(invoke).toHaveBeenCalledWith(EXTERNAL_LIBRARY_CHANNELS.list, {});
    invoke.mockResolvedValueOnce({ sources: [], checking: false, diagnostics: [], root: "/private/data" } as never);
    await expect(api.listExternalSources()).rejects.toThrow();
    invoke.mockResolvedValueOnce({ skills: [], uses: [] } as never);
    await api.readExternalSource({ sourceId: "a/b" });
    expect(invoke).toHaveBeenLastCalledWith(EXTERNAL_LIBRARY_CHANNELS.source, { sourceId: "a/b" });
    invoke.mockResolvedValueOnce({ status: "ready", marketplaces: [] } as never);
    await api.listExternalSourcesOnMac();
    invoke.mockResolvedValueOnce({
      status: "failed",
      skills: [],
      uses: [],
      marketplaceMatches: [],
      error: { type: "offline", message: "Offline" },
    } as never);
    await api.addExternalSource({ repository: "https://github.com/A/B.git" });
    expect(invoke).toHaveBeenLastCalledWith(EXTERNAL_LIBRARY_CHANNELS.add, { repository: "a/b" });
    invoke.mockResolvedValueOnce({
      status: "unavailable",
      useId: "use",
      base: { status: "unknown", reason: "No base" },
      files: [],
    } as never);
    await api.compareExternalUse({ useId: "use" });
    invoke.mockResolvedValueOnce({
      startedAt: "2026-10-12T12:00:00.000Z",
      finishedAt: "2026-10-12T12:00:00.000Z",
      result: "success",
      errors: 0,
      diagnostics: [],
    } as never);
    await api.checkExternalLibrary();
  });
});
