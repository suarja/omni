import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import { parseRegistryState, registerProject } from "../../src/domain/project-source-registry";

const temporaryRoots: string[] = [];

async function createStore(initial?: string) {
  const root = await mkdtemp(join(tmpdir(), "omni-registry-"));
  temporaryRoots.push(root);
  const filePath = join(root, "registry.json");
  if (initial !== undefined) {
    await writeFile(filePath, initial, { encoding: "utf8", mode: 0o600 });
  }
  return { filePath, store: createLocalJsonRegistryStore(filePath) };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("local JSON project and source registry", () => {
  it("starts with an empty revisioned registry", async () => {
    const { store } = await createStore();

    await expect(store.read()).resolves.toEqual({
      status: "ready",
      state: { schemaVersion: 1, revision: 0, projects: [], sources: [] },
    });
  });

  it("blocks an absent main file when a valid backup exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-registry-"));
    temporaryRoots.push(root);
    const filePath = join(root, "registry.json");
    const backupPath = `${filePath}.bak`;
    await writeFile(
      backupPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 7,
        projects: [],
        sources: [],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const store = createLocalJsonRegistryStore(filePath);

    const result = await store.read();

    expect(result).toMatchObject({ status: "corrupt", recoveryAvailable: true });
    expect((result as { diagnostic: string }).diagnostic).toMatch(/missing|backup/i);
    await expect(store.mutate(7, (state) => state)).resolves.toMatchObject({ status: "corrupt" });
  });

  it("shares one writer for repeated calls with the same resolved path", async () => {
    const { filePath, store: first } = await createStore();
    const second = createLocalJsonRegistryStore(join(filePath, "..", "registry.json"));

    expect(second).toBe(first);
    const results = await Promise.all([
      first.mutate(0, (state) => ({ ...state, projects: [] })),
      second.mutate(0, (state) => ({ ...state, sources: [] })),
    ]);

    expect(results.filter((result) => result.status === "ready")).toHaveLength(1);
    expect(results.filter((result) => result.status === "revision-conflict")).toHaveLength(1);
  });

  it("rejects valid symlink paths for both main and backup files", async () => {
    const mainRoot = await mkdtemp(join(tmpdir(), "omni-registry-"));
    const backupRoot = await mkdtemp(join(tmpdir(), "omni-registry-"));
    temporaryRoots.push(mainRoot, backupRoot);
    const mainPath = join(mainRoot, "registry.json");
    const mainTarget = join(mainRoot, "registry-target.json");
    const backupPath = join(backupRoot, "registry.json");
    const backupTarget = join(backupRoot, "backup-target.json");
    const valid = JSON.stringify({ schemaVersion: 1, revision: 0, projects: [], sources: [] });
    await writeFile(mainTarget, valid, { encoding: "utf8", mode: 0o600 });
    await symlink(mainTarget, mainPath);
    await writeFile(backupPath, valid, { encoding: "utf8", mode: 0o600 });
    await writeFile(backupTarget, valid, { encoding: "utf8", mode: 0o600 });
    await symlink(backupTarget, `${backupPath}.bak`);

    const mainResult = await createLocalJsonRegistryStore(mainPath).read();
    const backupResult = await createLocalJsonRegistryStore(backupPath).read();

    expect(mainResult).toMatchObject({ status: "corrupt", recoveryAvailable: false });
    expect((mainResult as { diagnostic: string }).diagnostic).toMatch(/symbolic link/i);
    expect(backupResult).toMatchObject({ status: "corrupt", recoveryAvailable: false });
    expect((backupResult as { diagnostic: string }).diagnostic).toMatch(/symbolic link/i);
  });

  it("leaves the main file and loaded state unchanged when backup persistence fails", async () => {
    const { filePath, store } = await createStore(
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        projects: [],
        sources: [],
      }),
    );
    await expect(store.read()).resolves.toMatchObject({ status: "ready", state: { revision: 0 } });
    await mkdir(`${filePath}.bak`);

    await expect(
      store.mutate(0, (state) => ({
        ...state,
        projects: [
          {
            id: "project-one",
            displayName: "Project One",
            locator: { kind: "local-directory" as const, canonicalPath: "/workspace/project-one" },
            createdAt: "2026-09-09T10:00:00.000Z",
          },
        ],
      })),
    ).rejects.toThrow(/regular|backup|directory/i);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ revision: 0, projects: [] });
    await expect(store.read()).resolves.toMatchObject({ status: "ready", state: { revision: 0, projects: [] } });
  });

  it("increments revisions and rejects stale mutations", async () => {
    const { store } = await createStore();
    const created = await store.mutate(0, (state) => ({
      ...state,
      projects: [
        {
          id: "project-one",
          displayName: "Project One",
          locator: { kind: "local-directory" as const, canonicalPath: "/workspace/project-one" },
          createdAt: "2026-09-09T10:00:00.000Z",
        },
      ],
    }));

    expect(created).toMatchObject({ status: "ready", state: { revision: 1 } });
    await expect(store.mutate(0, (state) => state)).resolves.toEqual({
      status: "revision-conflict",
      expected: 0,
      actual: 1,
    });
  });

  it("persists a main-side registration decision nextState", async () => {
    const { store } = await createStore();
    const mutation = await store.mutate(
      0,
      (state) =>
        registerProject(state, {
          id: "project-one",
          displayName: "Project One",
          canonicalPath: "/workspace/project-one",
          createdAt: "2026-09-09T10:00:00.000Z",
        }).nextState,
    );

    expect(mutation).toMatchObject({
      status: "ready",
      state: {
        revision: 1,
        projects: [{ id: "project-one", locator: { canonicalPath: "/workspace/project-one" } }],
      },
    });
  });

  it("serializes concurrent mutations through one revision queue", async () => {
    const { store } = await createStore();
    const append = (id: string) =>
      store.mutate(0, (state) => ({
        ...state,
        projects: [
          ...state.projects,
          {
            id,
            displayName: id,
            locator: { kind: "local-directory" as const, canonicalPath: `/workspace/${id}` },
            createdAt: "2026-09-09T10:00:00.000Z",
          },
        ],
      }));

    const results = await Promise.all([append("project-one"), append("project-two")]);

    expect(results.filter((result) => result.status === "ready")).toHaveLength(1);
    expect(results.filter((result) => result.status === "revision-conflict")).toHaveLength(1);
    await expect(store.read()).resolves.toMatchObject({ status: "ready", state: { revision: 1 } });
  });

  it("writes the final file and backup with mode 0600", async () => {
    const { filePath, store } = await createStore();
    await store.mutate(0, (state) => ({
      ...state,
      projects: [
        {
          id: "project-one",
          displayName: "Project One",
          locator: { kind: "local-directory" as const, canonicalPath: "/workspace/project-one" },
          createdAt: "2026-09-09T10:00:00.000Z",
        },
      ],
    }));

    const backupPath = `${filePath}.bak`;
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(backupPath, "utf8"))).toMatchObject({ revision: 1 });
    await expect(stat(`${filePath}.tmp`)).rejects.toThrow();
  });

  it("preserves invalid JSON, exposes recovery, and blocks mutations", async () => {
    const valid = JSON.stringify({ schemaVersion: 1, revision: 1, projects: [], sources: [] });
    const { filePath, store } = await createStore(valid);
    await chmod(`${filePath}`, 0o600);
    const backupPath = `${filePath}.bak`;
    await writeFile(backupPath, valid, { encoding: "utf8", mode: 0o600 });
    await writeFile(filePath, "{ invalid", "utf8");

    const result = await store.read();
    expect(result).toMatchObject({ status: "corrupt", recoveryAvailable: true });
    expect((result as { diagnostic: string }).diagnostic).toMatch(/JSON|parse/i);
    await expect(store.mutate(1, (state) => state)).resolves.toMatchObject({ status: "corrupt" });
    expect(await readFile(filePath, "utf8")).toBe("{ invalid");
  });

  it("blocks invalid records and unsupported schemas without making them writable", async () => {
    const invalid = JSON.stringify({ schemaVersion: 2, revision: 1, projects: [], sources: [] });
    const { filePath, store } = await createStore(invalid);

    await expect(store.read()).resolves.toMatchObject({ status: "corrupt", recoveryAvailable: false });
    await expect(store.mutate(0, (state) => state)).resolves.toMatchObject({ status: "corrupt" });
    expect(await readFile(filePath, "utf8")).toBe(invalid);
  });

  it("blocks an existing registry path that cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-registry-"));
    temporaryRoots.push(root);
    const filePath = join(root, "registry.json");
    await symlink(join(root, "missing-registry-target"), filePath);
    const store = createLocalJsonRegistryStore(filePath);

    const result = await store.read();

    expect(result).toMatchObject({ status: "corrupt", recoveryAvailable: false });
    expect((result as { diagnostic: string }).diagnostic).toMatch(/read|registry|directory/i);
    await expect(store.mutate(0, (state) => state)).resolves.toMatchObject({ status: "corrupt" });
  });

  it("does not accept canonical paths as a renderer-facing state field", () => {
    expect(() =>
      parseRegistryState({
        schemaVersion: 1,
        revision: 0,
        projects: [],
        sources: [],
        canonicalPath: "/private/path",
      }),
    ).toThrow(/unknown field/i);
  });
});
