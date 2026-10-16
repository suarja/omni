import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExternalSourcesStore } from "../../src/main/external-library/store";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("external sources persistence", () => {
  it("persists copy version matches and misses without losing them during source refresh writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-e1-version-cache-"));
    roots.push(root);
    const path = join(root, "external-sources.json"),
      store = createExternalSourcesStore(path);
    const source = { repo: "a/tools", arrival: "detected" as const, readCopyFolder: "a__tools" };
    await store.upsert(source);
    const key = { repo: source.repo, skillPath: "skills/a", copyHash: "a".repeat(64), head: "a".repeat(40) };
    await store.cacheCopyVersion({ ...key, result: { status: "not-found", bounded: true } });
    await store.upsert({ ...source, head: { commit: "b".repeat(40), date: "2026-10-12T12:00:00.000Z" } });
    expect((await createExternalSourcesStore(path).read()).copyVersions).toEqual([
      { ...key, result: { status: "not-found", bounded: true } },
    ]);
    await store.cacheCopyVersion({ ...key, result: { status: "found", commit: "a".repeat(40) } });
    expect((await createExternalSourcesStore(path).read()).copyVersions).toEqual([
      { ...key, result: { status: "found", commit: "a".repeat(40) } },
    ]);
  });
  it("rejects unsafe version-cache paths and duplicate cache identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-e1-unsafe-cache-"));
    roots.push(root);
    const path = join(root, "external-sources.json"),
      store = createExternalSourcesStore(path);
    const version = {
      repo: "a/tools",
      skillPath: "skills/a",
      copyHash: "a".repeat(64),
      head: "a".repeat(40),
      result: { status: "found" as const, commit: "a".repeat(40) },
    };
    await expect(store.cacheCopyVersion({ ...version, skillPath: "../private" })).rejects.toThrow();
    await writeFile(path, JSON.stringify({ schemaVersion: 1, sources: [], copyVersions: [version, version] }));
    await expect(store.read()).rejects.toThrow();
  });
  it("round trips every written shape and serializes concurrent additions", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-e1-store-"));
    roots.push(root);
    const path = join(root, "external-sources.json");
    const store = createExternalSourcesStore(path);
    await Promise.all([
      store.upsert({ repo: "a/tools", arrival: "detected", readCopyFolder: "a__tools" }),
      store.upsert({
        repo: "b/tools",
        arrival: "owner",
        readCopyFolder: "b__tools",
        lastCheckAt: "2026-10-12T12:00:00.000Z",
        head: { commit: "a".repeat(40), date: "2026-10-12T12:00:00.000Z" },
        lastError: { type: "offline", message: "Offline." },
      }),
    ]);
    const record = await store.read();
    expect(record.sources).toHaveLength(2);
    expect(await createExternalSourcesStore(path).read()).toEqual(record);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record);
    await store.upsert({ ...record.sources[1]!, lastError: undefined });
    expect((await store.read()).sources[1]).not.toHaveProperty("lastError");
  });
  it("fails closed on corrupt stores and symlink destinations without overwriting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-e1-corrupt-"));
    roots.push(root);
    const path = join(root, "external-sources.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 99, sources: [] }));
    await expect(
      createExternalSourcesStore(path).upsert({ repo: "a/b", arrival: "owner", readCopyFolder: "a__b" }),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(99);
    const link = join(root, "link.json");
    await symlink(path, link);
    await expect(createExternalSourcesStore(link).read()).rejects.toThrow();
  });
  it("refuses two repositories that would share the same read-copy folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-e1-collision-"));
    roots.push(root);
    const store = createExternalSourcesStore(join(root, "external-sources.json"));
    await store.upsert({ repo: "a__b/c", arrival: "detected", readCopyFolder: "a__b__c" });
    await expect(store.upsert({ repo: "a/b__c", arrival: "owner", readCopyFolder: "a__b__c" })).rejects.toThrow();
    expect((await store.read()).sources.map((source) => source.repo)).toEqual(["a__b/c"]);
  });
});
