import { afterEach, expect, it, vi } from "vitest";
import { EXTERNAL_LIBRARY_UI_CHANNELS, parseExternalImportRequest } from "../../src/shared/external-library-ui-ipc";
import { createExternalLibraryUiDesktopApi } from "../../src/preload/external-library-ui";
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
});
it("guards all UI adapters before parsing and accepts only checked identities", async () => {
  const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
  vi.doMock("electron", () => ({ ipcMain: { handle: (name: string, handler: never) => handlers.set(name, handler) } }));
  const adapter = {
    discover: vi.fn(async () => ({ status: "failed", error: { type: "offline", message: "Offline" } })),
    importSource: vi.fn(async () => ({
      kind: "source",
      id: "external-copy",
      grantHandle: "grant",
      relativePath: "skills/demo",
    })),
    readDocument: vi.fn(async () => ({ status: "read", content: "cached skill", byteLength: 12, truncated: false })),
    openRepository: vi.fn(async () => ({ status: "opened" })),
  };
  const { registerExternalLibraryUiIpc } = await import("../../src/main/external-library/ui-ipc");
  registerExternalLibraryUiIpc((event) => {
    if (!event) throw new Error("Untrusted sender");
  }, adapter as never);
  expect(handlers.size).toBe(4);
  for (const handler of handlers.values()) await expect(handler(null, {})).rejects.toThrow("Untrusted sender");
  await expect(
    handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.discover)!({}, { repository: "https://private@github.com/a/b" }),
  ).rejects.toThrow();
  await expect(
    handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.importSource)!({}, { sourceId: "a/b", skillPath: "../private" }),
  ).rejects.toThrow();
  await expect(
    handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.openRepository)!({}, { sourceId: "a/b", url: "https://evil.example" }),
  ).rejects.toThrow();
  expect(adapter.discover).not.toHaveBeenCalled();
  expect(adapter.importSource).not.toHaveBeenCalled();
  expect(adapter.openRepository).not.toHaveBeenCalled();
  await expect(
    handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.readDocument)!({}, { sourceId: "a/b", skillPath: "../private" }),
  ).rejects.toThrow();
  await expect(
    handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.readDocument)!(
      {},
      { sourceId: "a/b", skillPath: "skills/demo", root: "/private" },
    ),
  ).rejects.toThrow();
  expect(adapter.readDocument).not.toHaveBeenCalled();
  await handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.discover)!({}, { repository: "https://github.com/A/B" });
  expect(adapter.discover).toHaveBeenCalledWith("a/b");
  await handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.importSource)!({}, { sourceId: "a/b", skillPath: "skills/demo" });
  expect(adapter.importSource).toHaveBeenCalledWith({ sourceId: "a/b", skillPath: "skills/demo" });
  await handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.openRepository)!({}, { sourceId: "a/b" });
  expect(adapter.openRepository).toHaveBeenCalledWith("a/b");
  await handlers.get(EXTERNAL_LIBRARY_UI_CHANNELS.readDocument)!({}, { sourceId: "a/b", skillPath: "skills/demo" });
  expect(adapter.readDocument).toHaveBeenCalledWith({ sourceId: "a/b", skillPath: "skills/demo" });
});
it("validates UI requests and responses on both sides of the preload", async () => {
  const invoke = vi.fn(async () => ({ status: "opened" }));
  const api = createExternalLibraryUiDesktopApi(invoke);
  await expect(api.discoverExternalSource({ repository: "../private" })).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  expect(() => parseExternalImportRequest({ sourceId: "a/b", skillPath: "skills/demo", root: "/private" })).toThrow();
  await api.openExternalSourceRepository({ sourceId: "a/b" });
  expect(invoke).toHaveBeenCalledWith(EXTERNAL_LIBRARY_UI_CHANNELS.openRepository, { sourceId: "a/b" });
  invoke.mockResolvedValueOnce({
    kind: "source",
    id: "external-copy",
    grantHandle: "grant",
    relativePath: "../private",
  } as never);
  await expect(api.prepareExternalSkillImport({ sourceId: "a/b", skillPath: "skills/demo" })).rejects.toThrow();
  invoke.mockResolvedValueOnce({
    status: "failed",
    error: { type: "offline", message: "Offline" },
    path: "/private",
  } as never);
  await expect(api.discoverExternalSource({ repository: "a/b" })).rejects.toThrow();
  await expect(api.readExternalSkillDocument({ sourceId: "a/b", skillPath: "../private" })).rejects.toThrow();
  invoke.mockResolvedValueOnce({ status: "read", content: "cached", byteLength: 6, truncated: false } as never);
  expect((await api.readExternalSkillDocument({ sourceId: "a/b", skillPath: "skills/demo" })).status).toBe("read");
  expect(invoke).toHaveBeenLastCalledWith(EXTERNAL_LIBRARY_UI_CHANNELS.readDocument, {
    sourceId: "a/b",
    skillPath: "skills/demo",
  });
  invoke.mockResolvedValueOnce({ status: "read", content: 42, byteLength: 6, truncated: false } as never);
  await expect(api.readExternalSkillDocument({ sourceId: "a/b", skillPath: "skills/demo" })).rejects.toThrow();
});
