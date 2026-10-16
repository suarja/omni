import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canUpdate, createAppUpdates } from "../../src/main/app-updates/service";
import { createUpdatePreferences } from "../../src/main/app-updates/preferences";

const eligible = {
  isPackaged: true,
  channel: "release" as const,
  profileSource: "default" as const,
  signing: "developer-id",
  platform: "darwin",
  test: false,
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function fixture(policy = eligible) {
  let enabled = true;
  const updater = Object.assign(new EventEmitter(), { quitAndInstall: vi.fn() });
  const stopUpdates = vi.fn();
  const start = vi.fn(() => ({ stopUpdates }));
  const verifySignature = vi.fn(async () => true);
  const preferences = {
    read: async () => enabled,
    write: async (value: boolean) => {
      enabled = value;
    },
  };
  const changed = vi.fn();
  const service = createAppUpdates({ policy, preferences, updater, start, verifySignature, changed });
  return { service, updater, start, stopUpdates, verifySignature, changed };
}
describe("app updates", () => {
  it.each([
    { isPackaged: false },
    { channel: "development" },
    { profileSource: "argument" },
    { profileSource: "environment" },
    { signing: "ad-hoc-local-only" },
    { platform: "linux" },
    { test: true },
  ])("never starts the updater outside its release policy: %j", async (override) => {
    const policy = { ...eligible, ...override };
    expect(canUpdate(policy)).toBe(false);
    const f = fixture(policy as typeof eligible);
    await f.service.initialize();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.verifySignature).not.toHaveBeenCalled();
  });
  it("requires a verified signature, starts once and stops immediately after opt-out", async () => {
    const f = fixture();
    await f.service.initialize();
    await f.service.initialize();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0]).toEqual([]);
    expect(await f.service.get()).toMatchObject({ available: true, enabled: true, downloaded: false });
    await f.service.set(false);
    expect(f.stopUpdates).toHaveBeenCalledOnce();
    expect(await f.service.get()).toMatchObject({ enabled: false });
    f.service.dispose();
  });
  it("refuses unsigned metadata even when a signature adapter is supplied", async () => {
    const f = fixture();
    f.verifySignature.mockResolvedValue(false);
    await f.service.initialize();
    expect(f.start).not.toHaveBeenCalled();
    expect((await f.service.get()).available).toBe(false);
  });
  it("replays a downloaded update on get and restarts only on explicit request", async () => {
    const f = fixture();
    await f.service.initialize();
    f.updater.emit("update-downloaded");
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    expect((await f.service.get()).downloaded).toBe(true);
    expect(f.changed).toHaveBeenCalled();
    await f.service.restart();
    expect(f.updater.quitAndInstall).toHaveBeenCalledOnce();
    f.service.dispose();
  });
  it("discards a late download after opt-out and rejects a premature restart", async () => {
    const f = fixture();
    await f.service.initialize();
    await expect(f.service.restart()).rejects.toThrow(/download/);
    await f.service.set(false);
    f.updater.emit("update-downloaded");
    expect((await f.service.get()).downloaded).toBe(false);
    await expect(f.service.restart()).rejects.toThrow();
    f.service.dispose();
  });
  it("persists the default-on decision and rejects malformed preferences", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-update-test-"));
    roots.push(root);
    const path = join(root, "updates.json");
    const store = createUpdatePreferences(path);
    expect(await store.read()).toBe(true);
    await store.write(false);
    expect(await createUpdatePreferences(path).read()).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 1, enabled: false });
    await writeFile(path, '{"schemaVersion":1,"enabled":"yes"}');
    await expect(createUpdatePreferences(path).read()).rejects.toThrow(/preferences/);
  });
});
