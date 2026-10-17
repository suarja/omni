import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
  vi.doUnmock("update-electron-app");
  vi.doUnmock("../../src/adapters/owned-child-processes");
  vi.doUnmock("../../src/main/app-updates/preferences");
  vi.useRealTimers();
});
it("installs after cleanup and window destruction, without later checks invalidating Squirrel", async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  let nativeAvailable = false;
  let mainExited = false;
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const updater = Object.assign(new EventEmitter(), {
    quitAndInstall: vi.fn(() => {
      order.push("native install");
      if (!nativeAvailable) throw new Error("No update available, can't quit and install");
      mainExited = true;
    }),
  });
  const destroy = vi.fn(() => {
    order.push("destroy windows");
  });
  vi.doMock("electron", () => ({ autoUpdater: updater, BrowserWindow: { getAllWindows: () => [{ destroy }] } }));
  vi.doMock("../../src/adapters/owned-child-processes", () => ({
    execFile: (...args: unknown[]) => (args.at(-1) as Function)(null, "", ""),
  }));
  vi.doMock("../../src/main/app-updates/preferences", () => ({
    createUpdatePreferences: () => ({ read: async () => true, write: async () => {} }),
  }));
  let checks = 0;
  const start = vi.fn(() => {
    const timer = setInterval(() => {
      checks++;
      // Pinned Electron's empty-check path clears g_update_available.
      nativeAvailable = false;
      updater.emit("update-not-available");
    }, 3600000);
    return { stopUpdates: () => clearInterval(timer) };
  });
  vi.doMock("update-electron-app", () => ({
    updateElectronApp: start,
    UpdateSourceType: { ElectronPublicUpdateService: 0 },
  }));
  const { createElectronAppUpdates } = await import("../../src/main/app-updates/electron-adapter");
  const service = createElectronAppUpdates({
    appRoot: "/scratch/Omni.app/Contents/Resources/app",
    userDataPath: "/scratch/profile",
    policy: {
      isPackaged: true,
      channel: "release",
      profileSource: "default",
      signing: "developer-id",
      platform: "darwin",
      test: false,
    },
    changed: vi.fn(),
    prepareForUpdate: async () => {
      await cleanup;
      order.push("cleanup");
    },
  });
  await service.initialize();
  nativeAvailable = true;
  updater.emit("update-downloaded");
  await vi.advanceTimersByTimeAsync(7200000);
  expect(checks).toBe(0);
  expect((await service.get()).downloaded).toBe(true);
  const restart = service.restart();
  await Promise.resolve();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  finish();
  await restart;
  expect(order).toEqual(["cleanup", "destroy windows", "native install"]);
  expect(mainExited).toBe(true);
  service.dispose();
});
