import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
const record = {
  storefrontSourceId: "storefront",
  pluginId: "demo",
  workshopPackagePath: "packages/demo",
  baseCommit: "abcdef1",
  publishedHashes: { "SKILL.md": "a".repeat(64) },
  publishedTime: "2026-10-12T10:00:00.000Z",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-publications-"));
  roots.push(root);
  return { root, path: join(root, "publications.json") };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("loads every persisted publication field and serializes concurrent atomic saves", async () => {
  const { path } = await fixture();
  const { createPublicationsStore } = await import("../../src/main/storefronts/publications-store");
  const store = createPublicationsStore(path);
  expect(await store.read()).toEqual({ status: "ready", publications: [] });
  await Promise.all([store.save([record]), store.save([{ ...record, pluginId: "second" }])]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    schemaVersion: 1,
    publications: [record, { ...record, pluginId: "second" }],
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual(JSON.parse(await readFile(path, "utf8")));
});
it("reports corrupt persisted state and a valid backup without overwriting it", async () => {
  const { path } = await fixture();
  await writeFile(path, "broken");
  await writeFile(`${path}.bak`, JSON.stringify({ schemaVersion: 1, publications: [record] }));
  const { createPublicationsStore } = await import("../../src/main/storefronts/publications-store");
  const store = createPublicationsStore(path);
  expect(await store.save([record])).toMatchObject({ status: "corrupt", recoveryAvailable: true });
  expect(await readFile(path, "utf8")).toBe("broken");
});
it("refuses symbolic-link stores and non-file targets", async () => {
  const { root, path } = await fixture();
  await writeFile(join(root, "outside"), "preserve");
  await symlink(join(root, "outside"), path);
  const { createPublicationsStore } = await import("../../src/main/storefronts/publications-store");
  expect(await createPublicationsStore(path).save([record])).toMatchObject({ status: "corrupt" });
  expect(await readFile(join(root, "outside"), "utf8")).toBe("preserve");
  await mkdir(join(root, "directory"));
  expect(await createPublicationsStore(join(root, "directory")).read()).toMatchObject({ status: "corrupt" });
});
it("preserves external edits after loading instead of overwriting them", async () => {
  const { path } = await fixture();
  const { createPublicationsStore } = await import("../../src/main/storefronts/publications-store");
  const store = createPublicationsStore(path);
  await store.save([record]);
  const modified = JSON.stringify({ schemaVersion: 1, publications: [{ ...record, baseCommit: "1234567" }] });
  await writeFile(path, modified);
  await expect(store.save([record])).rejects.toThrow(/changed locally/i);
  expect(await readFile(path, "utf8")).toBe(modified);
});
