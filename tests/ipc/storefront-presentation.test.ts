import { afterEach, expect, it, vi } from "vitest";
import { registerStorefrontIpcHandlers } from "../../src/main/storefronts/ipc";
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(name, handler),
  },
  app: { getPath: () => "/fixture/data" },
  dialog: {},
  shell: { openExternal: vi.fn() },
}));
afterEach(() => handlers.clear());
it("rejects arbitrary paths and URLs before opening a storefront repository", async () => {
  registerStorefrontIpcHandlers(() => {}, { userDataPath: "/fixture/data" });
  const open = handlers.get("omni:storefronts:open-repository");
  expect(open).toBeDefined();
  await expect(open!({}, { sourceId: "../private" })).rejects.toThrow();
  await expect(open!({}, { sourceId: "storefront", url: "https://example.com" })).rejects.toThrow();
});
it("checks renderer trust before reading storefront metadata", async () => {
  registerStorefrontIpcHandlers(
    () => {
      throw new Error("Untrusted sender.");
    },
    { userDataPath: "/fixture/data" },
  );
  const details = handlers.get("omni:storefronts:details");
  expect(details).toBeDefined();
  await expect(details!({}, { sourceId: "storefront" })).rejects.toThrow("Untrusted sender.");
});

it("validates the plugin selector and renderer trust before reading content checks", async () => {
  registerStorefrontIpcHandlers(() => {}, { userDataPath: "/fixture/data" });
  const check = handlers.get("omni:storefronts:content-checks")!;
  await expect(check({}, { pluginId: "../private" })).rejects.toThrow();
  await expect(check({}, { pluginId: "demo", root: "/private" })).rejects.toThrow();
  registerStorefrontIpcHandlers(
    () => {
      throw new Error("Untrusted sender.");
    },
    { userDataPath: "/fixture/data" },
  );
  await expect(handlers.get("omni:storefronts:content-checks")!({}, { pluginId: "demo" })).rejects.toThrow(
    "Untrusted sender.",
  );
});
