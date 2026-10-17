import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSettingsStore } from "../../src/main/settings-store";
import { parseSettingsResponse, parseSettingsSetRequest, type Settings } from "../../src/shared/settings-ipc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function update(settings: Settings) {
  return {
    commitChanges: settings.git.commitChanges,
    agents: settings.agents,
    ai: settings.ai,
    features: settings.features,
    externalLibrary: settings.externalLibrary,
  };
}

it("persists a setup dismissal across reloads and preserves it through other settings writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-p2-settings-"));
  roots.push(root);
  const path = join(root, "settings.json");
  const store = createSettingsStore(path);
  const defaults = await store.read();
  expect(defaults.workspaceSetupHidden ?? false).toBe(false);
  await store.set({ ...update(defaults), workspaceSetupHidden: true });
  await store.set({ ...update(defaults), commitChanges: false });
  const stored = JSON.parse(await readFile(path, "utf8"));
  expect(parseSettingsResponse(stored).workspaceSetupHidden).toBe(true);
  const reloadedPath = join(root, "reloaded.json");
  await writeFile(reloadedPath, JSON.stringify(stored));
  const reloaded = createSettingsStore(reloadedPath);
  expect((await reloaded.read()).workspaceSetupHidden).toBe(true);
  expect((await reloaded.set({ ...update(defaults), workspaceSetupHidden: false })).workspaceSetupHidden).toBe(false);
});

it("rejects a non-boolean setup preference at both settings boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-p2-settings-invalid-"));
  roots.push(root);
  const defaults = await createSettingsStore(join(root, "settings.json")).read();
  for (const invalid of [null, 0, "true", {}, []]) {
    expect(() => parseSettingsSetRequest({ ...update(defaults), workspaceSetupHidden: invalid })).toThrow();
    expect(() => parseSettingsResponse({ ...defaults, workspaceSetupHidden: invalid })).toThrow();
  }
});
