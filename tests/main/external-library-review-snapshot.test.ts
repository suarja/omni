import { rm, readFile, symlink, mkdir } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { instrumentGitProcesses } from "../helpers/git-process-metrics";
const metrics = vi.hoisted(() => ({ commands: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) =>
  instrumentGitProcesses(await importOriginal(), (args) => metrics.commands.push([...args])),
);
import * as inventory from "../../src/adapters/inventory/local-filesystem";
import * as useReader from "../../src/main/external-library/use-reader";
import { createExternalProjectStateReader } from "../../src/main/external-library/project-state";
import { parseSkillsLock } from "../../src/domain/skill-origins/skills-lock";
import { git, write, commit } from "../helpers/publication-fixture";
import { createExternalLibraryService } from "../../src/main/external-library/service";
import { externalLibraryFixture } from "../helpers/external-library-fixture";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("serves library, source and Mac reads from one pass without Git or source walks", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  const recovery = vi.spyOn(useReader, "readExternalBase");
  await service.check();
  expect(
    metrics.commands.filter((args) => args.includes("--format=%x00%cI") && args.includes("--name-only")),
  ).toHaveLength(3);
  expect(recovery).not.toHaveBeenCalled();
  const original = inventory.createLocalInventoryPort;
  const walks: string[] = [];
  vi.spyOn(inventory, "createLocalInventoryPort").mockImplementation((root, options) => {
    const port = original(root, options);
    return {
      ...port,
      listDirectory: async (path) => {
        walks.push(root);
        return port.listDirectory(path);
      },
    };
  });
  metrics.commands = [];
  const first = await service.list();
  const source = await service.readSource("fixture/tools");
  expect(source.skills.every((skill) => skill.lastChangeAt && Number.isFinite(Date.parse(skill.lastChangeAt)))).toBe(
    true,
  );
  await service.onMac();
  expect(await service.list()).toEqual(first);
  expect(source.uses.find((use) => use.skillKey === "modified")?.base.status).toBe("unknown");
  expect(metrics.commands).toEqual([]);
  expect(walks).toEqual([]);
}, 60000);
it("recovers a modified use once and caches its base and comparison until the next source HEAD", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  await service.check();
  const use = (await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "modified")!;
  metrics.commands = [];
  const first = await service.compare(use.id);
  expect(first.status).toBe("ready");
  const firstCost = metrics.commands.length;
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(1);
  metrics.commands = [];
  expect(await service.compare(use.id)).toEqual(first);
  expect(metrics.commands).toEqual([]);
  console.info(
    JSON.stringify({
      fixture: "E1",
      listGitProcesses: 0,
      compareGitProcesses: firstCost,
      cachedCompareGitProcesses: 0,
    }),
  );
}, 60000);

it("projects modified external rows from snapshot hashes and existing origin verification without recovery", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  await service.check();
  const entry = parseSkillsLock(JSON.parse(await readFile(`${f.projectB}/skills-lock.json`, "utf8"))).entries.find(
    (entry) => entry.skillKey === "modified",
  )!;
  const readState = createExternalProjectStateReader({
    userDataPath: f.data,
    projectId: "project-b",
    origins: [".agents", ".claude"].map((agent) => ({
      ...entry,
      artifactId: agent,
      relativePath: `${agent}/skills/modified/SKILL.md`,
      lockPath: "skills-lock.json",
      verification: "modified",
    })),
  });
  const port = vi.spyOn(inventory, "createLocalInventoryPort");
  metrics.commands = [];
  expect(await readState(".agents/skills/modified")).toBe("modified-here");
  expect(await readState(".claude/skills/modified")).toBe("modified-here");
  expect(port).not.toHaveBeenCalled();
  expect(metrics.commands).toEqual([]);
}, 60000);
it("shows persisted source facts and unknown uses before the first completed pass", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  await createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl }).check();
  const reopened = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  metrics.commands = [];
  const original = inventory.createLocalInventoryPort;
  const walks = vi.fn();
  vi.spyOn(inventory, "createLocalInventoryPort").mockImplementation((root, options) => {
    const port = original(root, options);
    return {
      ...port,
      listDirectory: async (path) => {
        walks(root);
        return port.listDirectory(path);
      },
    };
  });
  const source = await reopened.readSource("fixture/tools");
  expect(source.source?.head?.commit).toBe(f.removalCommit);
  expect(source.uses).toHaveLength(5);
  expect(source.uses.every((use) => use.state === "unknown")).toBe(true);
  expect(metrics.commands).toEqual([]);
  expect(walks).not.toHaveBeenCalled();
}, 60000);
it("recovers again after a source HEAD change and withholds stale project fingerprints", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  await service.check();
  const use = (await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "modified")!;
  await service.compare(use.id);
  await write(f.upstream, "skills/unused/new.txt", "new");
  await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  await service.check();
  metrics.commands = [];
  expect((await service.compare(use.id)).status).toBe("ready");
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(1);
  await write(f.projectB, ".agents/skills/modified/SKILL.md", "Changed after observation.");
  metrics.commands = [];
  expect((await service.compare(use.id)).status).toBe("unavailable");
  expect(metrics.commands).toEqual([]);
}, 60000);

it("keeps an unsafe upstream entrypoint unknown instead of claiming it was removed", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  await git(f.upstream, "rm", "skills/current/SKILL.md");
  await mkdir(`${f.upstream}/skills/current`, { recursive: true });
  await symlink(`${f.projectA}/.agents/skills/current/SKILL.md`, `${f.upstream}/skills/current/SKILL.md`);
  await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  await service.check();
  expect((await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "current")?.state).toBe(
    "unknown",
  );
}, 60000);
