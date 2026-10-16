import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSettingsStore } from "../../src/main/settings-store";
import { createLoginItemService } from "../../src/main/login-item";
import { parseSettingsResponse, DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(policy = {}) {
  const root = await mkdtemp(join(tmpdir(), "omni-login-"));
  roots.push(root);
  const store = createSettingsStore(join(root, "settings.json"));
  let enabled = false;
  const os = {
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: enabled,
      wasOpenedAtLogin: false,
      status: enabled ? "enabled" : "not-registered",
    })),
    setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => {
      enabled = settings.openAtLogin;
    }),
  };
  const service = createLoginItemService({
    store,
    os,
    platform: "darwin",
    isPackaged: true,
    channel: "release",
    profileSource: "default",
    ...policy,
  });
  return {
    root,
    store,
    os,
    service,
    removeInSystemSettings: () => {
      enabled = false;
    },
  };
}
it("registers on the first release launch and never re-adds a removed login item", async () => {
  const f = await fixture();
  await f.service.initialize();
  expect(f.os.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true, type: "mainAppService" });
  expect((await f.store.read()).login).toEqual({ openAtLogin: true });
  f.removeInSystemSettings();
  await cp(join(f.root, "settings.json"), join(f.root, "restarted.json"));
  const restarted = createLoginItemService({
    store: createSettingsStore(join(f.root, "restarted.json")),
    os: f.os,
    platform: "darwin",
    isPackaged: true,
    channel: "release",
    profileSource: "default",
  });
  await restarted.initialize();
  expect(f.os.setLoginItemSettings).toHaveBeenCalledOnce();
  expect(await f.service.get()).toMatchObject({ openAtLogin: false, available: true });
});
it.each([
  { isPackaged: false },
  { channel: "development" },
  { profileSource: "environment" },
  { profileSource: "argument" },
  { platform: "linux" },
])("never accesses real login items for an ineligible run %j", async (policy) => {
  const f = await fixture(policy);
  await f.service.initialize();
  expect(await f.service.get()).toEqual({ available: false, openAtLogin: false, status: "unavailable" });
  await expect(f.service.set(true)).rejects.toThrow("installed release");
  expect(f.os.getLoginItemSettings).not.toHaveBeenCalled();
  expect(f.os.setLoginItemSettings).not.toHaveBeenCalled();
  expect((await f.store.read()).login).toBeUndefined();
});
it("registers and unregisters on an explicit toggle and reads the OS result", async () => {
  const f = await fixture();
  expect(await f.service.set(true)).toMatchObject({ openAtLogin: true });
  expect(await f.service.set(false)).toMatchObject({ openAtLogin: false });
  expect(f.os.setLoginItemSettings.mock.calls).toEqual([
    [{ openAtLogin: true, type: "mainAppService" }],
    [{ openAtLogin: false, type: "mainAppService" }],
  ]);
  expect((await f.store.read()).login).toEqual({ openAtLogin: false });
});
it("records the initial decision before registration fails so later launches do not re-add it", async () => {
  const f = await fixture();
  f.os.setLoginItemSettings.mockImplementation(() => {
    throw new Error("OS refused registration");
  });
  await expect(f.service.initialize()).rejects.toThrow("OS refused");
  await f.service.initialize();
  expect(f.os.setLoginItemSettings).toHaveBeenCalledOnce();
});
it("reports requires-approval as disabled even if openAtLogin is true", async () => {
  const f = await fixture();
  f.os.getLoginItemSettings.mockReturnValue({
    openAtLogin: true,
    wasOpenedAtLogin: false,
    status: "requires-approval",
  });
  expect(await f.service.get()).toMatchObject({ openAtLogin: false, status: "requires-approval" });
});
it("migrates v7 without inventing a login decision and retains it through unrelated writers", async () => {
  const f = await fixture();
  const legacy = {
    schemaVersion: 7,
    git: { commitChanges: false },
    agents: {
      approval: { personalMarketplace: "omni", projects: "conversation" },
      guard: { warnProjectIds: ["project"] },
    },
    ai: DEFAULT_AI_SETTINGS,
    features: DEFAULT_FEATURES,
    externalLibrary: { updates: "ask" },
  };
  await writeFile(join(f.root, "settings.json"), JSON.stringify(legacy));
  const current = await f.store.read();
  expect(parseSettingsResponse(current)).toEqual({ ...legacy, schemaVersion: 8 });
  await f.store.recordLoginDecision(false);
  await f.store.set({
    commitChanges: current.git.commitChanges,
    agents: current.agents,
    ai: current.ai,
    features: current.features,
    externalLibrary: current.externalLibrary,
  });
  await f.store.recordAgentVersion("test");
  const saved = JSON.parse(await readFile(join(f.root, "settings.json"), "utf8"));
  expect(parseSettingsResponse(saved).login).toEqual({ openAtLogin: false });
});
it("rejects malformed stored login decisions at the response boundary", async () => {
  const f = await fixture();
  const current = await f.store.read();
  expect(() => parseSettingsResponse({ ...current, login: { openAtLogin: "yes" } })).toThrow();
  expect(() => parseSettingsResponse({ ...current, login: { openAtLogin: true, extra: true } })).toThrow();
});
