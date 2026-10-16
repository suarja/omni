import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsStore } from "../../src/main/settings-store";
import { parseSettingsResponse, parseSettingsSetRequest } from "../../src/shared/settings-ipc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("external library settings", () => {
  it("migrates rc.11 settings and preserves ask through every write and reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-e1-settings-"));
    roots.push(root);
    const path = join(root, "settings.json");
    const legacy = JSON.parse(
      await readFile(join(import.meta.dirname, "../fixtures/persisted-state/rc9/settings.json"), "utf8"),
    );
    await writeFile(path, JSON.stringify(legacy));
    const store = createSettingsStore(path);
    const current = await store.read();
    expect(current).toEqual({ ...legacy, schemaVersion: 8, externalLibrary: { updates: "auto" } });
    const saved = await store.set({
      commitChanges: current.git.commitChanges,
      agents: current.agents,
      ai: current.ai,
      features: current.features,
      externalLibrary: { updates: "ask" },
    } as never);
    expect(saved.externalLibrary).toEqual({ updates: "ask" });
    expect((await store.recordAgentVersion("fixture")).externalLibrary).toEqual({ updates: "ask" });
    expect(parseSettingsResponse(JSON.parse(await readFile(path, "utf8"))).externalLibrary).toEqual({ updates: "ask" });
    expect(() =>
      parseSettingsSetRequest({
        commitChanges: true,
        agents: saved.agents,
        ai: saved.ai,
        features: saved.features,
        externalLibrary: { updates: "daily" },
      }),
    ).toThrow();
    expect(() => parseSettingsResponse({ ...saved, externalLibrary: { updates: "auto", extra: true } })).toThrow();
  });
});
