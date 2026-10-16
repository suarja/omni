import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseStorefrontDriftReport,
  parseStorefrontInspectResponse,
  parseStorefrontLinkRequest,
  STOREFRONTS_IPC_CHANNELS,
} from "../../src/shared/storefronts-ipc";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
  vi.doUnmock("../../src/main/storefronts/service");
});
describe("storefront IPC boundaries", () => {
  it("accepts a display origin and rejects control characters at the inspection boundary", () => {
    const inspection = {
      status: "ready",
      inspectionId: "fixture",
      displayName: "Storefront",
      isGitRepository: true,
      plugins: [],
      originUrl: "~/remotes/storefront.git",
    };
    expect(parseStorefrontInspectResponse(inspection)).toMatchObject({ originUrl: inspection.originUrl });
    expect(() => parseStorefrontInspectResponse({ ...inspection, originUrl: "origin\nsecret" })).toThrow();
  });

  it("rejects renderer paths and unsafe read-model payloads", () => {
    expect(() => parseStorefrontLinkRequest({ inspectionId: "../folder" })).toThrow();
    expect(() => parseStorefrontLinkRequest({ inspectionId: "fixture", path: "/private/folder" })).toThrow();
    expect(() =>
      parseStorefrontInspectResponse({
        status: "ready",
        inspectionId: "fixture",
        displayName: "Storefront",
        isGitRepository: true,
        plugins: [],
        canonicalPath: "/private/folder",
      }),
    ).toThrow();
    expect(() =>
      parseStorefrontDriftReport({ status: "ready", storefronts: [], absolutePath: "/private/folder" }),
    ).toThrow();
  });
  it("links only an inspected folder and checks sender trust and expiration", async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
    const inspect = vi.fn(async () => ({
      status: "ready",
      displayName: "Storefront",
      isGitRepository: true,
      plugins: [],
    }));
    const link = vi.fn(async () => ({
      status: "linked",
      sourceId: "storefront",
      inspection: await inspect(),
      publications: [],
    }));
    vi.doMock("electron", () => ({
      ipcMain: {
        handle: (name: string, handler: typeof handlers extends Map<string, infer V> ? V : never) =>
          handlers.set(name, handler),
      },
      app: { getPath: () => "/fixture/data" },
      dialog: {},
    }));
    vi.doMock("../../src/main/storefronts/service", () => ({
      createStorefrontService: () => ({ inspect, link, readDrift: async () => ({ status: "ready", storefronts: [] }) }),
    }));
    let time = 0;
    const { registerStorefrontIpcHandlers } = await import("../../src/main/storefronts/ipc");
    registerStorefrontIpcHandlers(
      (event) => {
        if (!event) throw new Error("Untrusted sender.");
      },
      {
        userDataPath: "/fixture/data",
        now: () => time,
        directoryPicker: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/fixture/storefront"] }) },
      },
    );
    const invoke = (name: string, request: unknown = {}) => handlers.get(name)!({}, request);
    await expect(handlers.get(STOREFRONTS_IPC_CHANNELS.inspect)!(null, {})).rejects.toThrow(/untrusted/i);
    const response = (await invoke(STOREFRONTS_IPC_CHANNELS.inspect)) as { inspectionId: string };
    expect(response.inspectionId).not.toContain("/");
    await expect(invoke(STOREFRONTS_IPC_CHANNELS.link, { inspectionId: response.inspectionId })).resolves.toMatchObject(
      { status: "linked" },
    );
    expect(link).toHaveBeenCalledWith("/fixture/storefront");
    time = 600000;
    await expect(invoke(STOREFRONTS_IPC_CHANNELS.link, { inspectionId: response.inspectionId })).resolves.toMatchObject(
      { status: "blocked", code: "inspection-expired" },
    );
    await expect(invoke(STOREFRONTS_IPC_CHANNELS.drift)).resolves.toEqual({ status: "ready", storefronts: [] });
  });
  it("preload validates link input and every storefront response", async () => {
    const expose = vi.fn();
    const invoke = vi.fn(async () => ({ status: "ready", storefronts: [] }));
    vi.doMock("electron", () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }));
    await import("../../src/preload/index");
    const api = expose.mock.calls[0]![1] as import("../../src/shared/storefronts-ipc").StorefrontsDesktopApi;
    await expect(api.linkStorefront({ inspectionId: "../invalid" })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await expect(api.readStorefrontDrift()).resolves.toEqual({ status: "ready", storefronts: [] });
    expect(invoke).toHaveBeenCalledWith(STOREFRONTS_IPC_CHANNELS.drift, {});
    invoke.mockResolvedValueOnce({ status: "ready", storefronts: [], root: "/private/folder" } as never);
    await expect(api.readStorefrontDrift()).rejects.toThrow();
  });
});
