import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import { registerSource } from "../../src/domain/project-source-registry";

const run = promisify(execFile);
const roots: string[] = [];
const now = "2026-10-12T10:00:00.000Z";
async function git(root: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root })).stdout.trim();
}
async function write(root: string, path: string, text: string | Uint8Array): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
async function fingerprint(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    for (const node of await readdir(join(root, path), { withFileTypes: true })) {
      const child = path ? `${path}/${node.name}` : node.name;
      if (node.isDirectory()) await visit(child);
      else
        hashes[child] = createHash("sha256")
          .update(await readFile(join(root, child)))
          .digest("hex");
    }
  }
  await visit("");
  return hashes;
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-storefronts-")));
  roots.push(root);
  const workshop = join(root, "workshop");
  const storefront = join(root, "storefront");
  const data = join(root, "data");
  await mkdir(workshop);
  await mkdir(storefront);
  for (const folder of [workshop, storefront]) {
    await git(folder, "init", "-q");
    await git(folder, "config", "user.name", "Fixture");
    await git(folder, "config", "user.email", "ada@example.com");
  }
  await git(workshop, "remote", "add", "origin", "git@github.com:fixture/workshop.git");
  await git(storefront, "remote", "add", "origin", "https://github.com/fixture/storefront.git");
  const base = {
    same: "a",
    workshop: "a",
    storefront: "a",
    conflict: "a",
    removed: "a",
    "omni.plugin.json": '{"name":"demo"}',
  };
  for (const [path, content] of Object.entries(base)) await write(workshop, `packages/demo/${path}`, content);
  await write(workshop, "omni.marketplace.json", JSON.stringify({ name: "Workshop", packages: ["packages/demo"] }));
  await git(workshop, "add", ".");
  await git(workshop, "commit", "-qm", "Fixture workshop");
  const commit = await git(workshop, "rev-parse", "HEAD");
  for (const [path, content] of Object.entries(base))
    if (path !== "omni.plugin.json") await write(storefront, `plugins/demo/${path}`, content);
  await write(storefront, "plugins/demo/.claude-plugin/plugin.json", '{"name":"demo","version":"1.0.0"}');
  await write(storefront, "plugins/foreign/.claude-plugin/plugin.json", '{"name":"foreign"}');
  await write(
    storefront,
    "plugins/demo/ORIGIN.md",
    `# Origin\n\n- Source repository: fixture/workshop (private)\n- Source path: packages/demo\n- Source commit: ${commit}\n- Published: 2026-10-11\n`,
  );
  await write(storefront, "LICENSE", "MIT License\n");
  await write(storefront, "plugins/demo/binary.png", new Uint8Array([0, 255, 128]));
  await git(storefront, "add", ".");
  await git(storefront, "commit", "-qm", "Fixture storefront");
  const registry = createLocalJsonRegistryStore(join(data, "omni/project-source-registry.json"));
  await registry.mutate(
    0,
    (state) =>
      registerSource(state, {
        id: "workshop",
        displayName: "Workshop",
        canonicalPath: workshop,
        ownership: "personal",
        createdAt: now,
      }).nextState,
  );
  return { root, workshop, storefront, data, registry, commit };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("linking storefronts and reading publications", () => {
  it("does not recognize a declared workshop package whose directory is missing", async () => {
    const f = await fixture();
    await rm(join(f.workshop, "packages/demo"), { recursive: true });
    const { createStorefrontService } = await import("../../src/main/storefronts/service");
    const inspection = await createStorefrontService({ userDataPath: f.data }).inspect(f.storefront);
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") throw new Error("Expected storefront inspection.");
    expect(inspection.plugins.find((plugin) => plugin.pluginId === "demo")?.recognition).toBe(
      "not-from-your-marketplace",
    );
  });
  it("recognizes workshop origins and persists publications without changing any storefront file", async () => {
    const fixtureData = await fixture();
    const before = await fingerprint(fixtureData.storefront);
    const { createStorefrontService } = await import("../../src/main/storefronts/service");
    const service = createStorefrontService({ userDataPath: fixtureData.data, now: () => Date.parse(now) });
    const inspected = await service.inspect(fixtureData.storefront);
    expect(inspected).toMatchObject({
      status: "ready",
      isGitRepository: true,
      githubRepository: "fixture/storefront",
      licenseFile: "LICENSE",
    });
    if (inspected.status !== "ready") throw new Error("Expected fixture inspection.");
    expect(inspected.plugins.map((plugin) => [plugin.pluginId, plugin.recognition])).toEqual([
      ["demo", "recognized"],
      ["foreign", "not-from-your-marketplace"],
    ]);
    expect(await service.link(fixtureData.storefront)).toMatchObject({
      status: "linked",
      publications: [{ pluginId: "demo", baseCommit: fixtureData.commit }],
    });
    expect(await fingerprint(fixtureData.storefront)).toEqual(before);
    const persisted = JSON.parse(await readFile(join(fixtureData.data, "omni/publications.json"), "utf8"));
    expect(persisted.publications).toHaveLength(1);
    expect(persisted.publications[0].publishedHashes["binary.png"]).toBe(
      createHash("sha256")
        .update(new Uint8Array([0, 255, 128]))
        .digest("hex"),
    );
    const second = await service.link(fixtureData.storefront);
    expect(second.status).toBe("linked");
    expect(
      JSON.parse(await readFile(join(fixtureData.data, "omni/publications.json"), "utf8")).publications,
    ).toHaveLength(1);
  });
  it("reads all file classifications and reports a missing base as a visible state", async () => {
    const f = await fixture();
    const { createStorefrontService } = await import("../../src/main/storefronts/service");
    const service = createStorefrontService({ userDataPath: f.data });
    await service.link(f.storefront);
    await write(f.workshop, "packages/demo/workshop", "b");
    await write(f.workshop, "packages/demo/conflict", "c");
    await write(f.workshop, "packages/demo/added", "b");
    await rm(join(f.workshop, "packages/demo/removed"));
    await write(f.storefront, "plugins/demo/storefront", "b");
    await write(f.storefront, "plugins/demo/conflict", "b");
    const report = await service.readDrift();
    expect(report.status).toBe("ready");
    if (report.status !== "ready") throw new Error("Expected drift.");
    expect(report.storefronts[0]).toMatchObject({ behind: true, behindPlugins: 1, toPublish: 3, conflicts: 1 });
    const plugin = report.storefronts[0]!.plugins[0]!;
    expect(plugin.status).toBe("ready");
    if (plugin.status !== "ready") throw new Error("Expected plugin drift.");
    for (const kind of [
      "unchanged",
      "workshop-changed",
      "storefront-only",
      "conflict",
      "added-in-workshop",
      "removed-in-workshop",
    ])
      expect(plugin.files.some((file) => file.classification === kind)).toBe(true);
    const { createPublicationsStore } = await import("../../src/main/storefronts/publications-store");
    const store = createPublicationsStore(join(f.data, "omni/publications.json"));
    const loaded = await store.read();
    if (loaded.status !== "ready") throw new Error("Expected publication store.");
    await store.save([{ ...loaded.publications[0]!, baseCommit: "f".repeat(40) }]);
    expect(await service.readDrift()).toMatchObject({
      status: "ready",
      storefronts: [{ unavailablePlugins: 1, plugins: [{ status: "missing-base", code: "base-commit-missing" }] }],
    });
  });
  it("refuses linked plugin symlinks instead of reading outside the storefront", async () => {
    const f = await fixture();
    await symlink(f.workshop, join(f.storefront, "plugins/demo/escape"));
    const { createStorefrontService } = await import("../../src/main/storefronts/service");
    const result = await createStorefrontService({ userDataPath: f.data }).link(f.storefront);
    expect(result).toMatchObject({ status: "blocked", code: "storefront-inspection-failed" });
  });
  it("classifies a removed workshop package as file removals and preserves a linked baseline", async () => {
    const f = await fixture();
    const { createStorefrontService } = await import("../../src/main/storefronts/service");
    const service = createStorefrontService({ userDataPath: f.data });
    const linked = await service.link(f.storefront);
    if (linked.status !== "linked") throw new Error("Expected linked fixture.");
    const original = linked.publications;
    await write(f.storefront, "plugins/demo/same", "storefront edit");
    expect(await service.link(f.storefront)).toMatchObject({ status: "linked", publications: original });
    await rm(join(f.workshop, "packages/demo"), { recursive: true });
    const report = await service.readDrift();
    expect(report).toMatchObject({ status: "ready", storefronts: [{ behind: true, plugins: [{ status: "ready" }] }] });
    if (report.status !== "ready") throw new Error("Expected drift.");
    const plugin = report.storefronts[0]!.plugins[0]!;
    if (plugin.status !== "ready") throw new Error("Expected file removals.");
    expect(plugin.files.find((file) => file.path === "same")?.classification).toBe("conflict");
    expect(plugin.files.find((file) => file.path === "removed")?.classification).toBe("removed-in-workshop");
  });
});
