import { rm, readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { instrumentGitProcesses } from "../helpers/git-process-metrics";
const metrics = vi.hoisted(() => ({ commands: [] as string[][], requests: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) =>
  instrumentGitProcesses(
    await importOriginal(),
    (args) => metrics.commands.push([...args]),
    (expression) => metrics.requests.push(expression),
  ),
);
import { createExternalLibraryService } from "../../src/main/external-library/service";
import { createExternalProjectStateReader } from "../../src/main/external-library/project-state";
import { externalLibraryFixture, fingerprint, folderHash } from "../helpers/external-library-fixture";
import { parseSkillsLock } from "../../src/domain/skill-origins/skills-lock";
import { git, write, commit } from "../helpers/publication-fixture";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("recognizes published copies despite foreign locks and preserves project fingerprints", async () => {
  const f = await externalLibraryFixture({ staleLocks: true });
  roots.push(f.root);
  const before = await Promise.all([f.projectA, f.projectB, f.home, f.folderSource].map(fingerprint));
  const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  expect((await service.check()).result).toBe("success");
  const source = await service.readSource("fixture/tools");
  expect(source.uses.find((use) => use.skillKey === "update")).toMatchObject({
    state: "update",
    lockStale: true,
    installedCommit: f.baseCommit,
    base: { status: "unknown" },
  });
  expect(source.uses.find((use) => use.skillKey === "removed")).toMatchObject({
    state: "removed",
    lockStale: true,
    installedCommit: f.baseCommit,
  });
  expect(source.uses.find((use) => use.skillKey === "current")).toMatchObject({
    state: "up-to-date",
    lockStale: true,
    installedCommit: f.removalCommit,
    sourceChanged: false,
  });
  expect(source.uses.find((use) => use.skillKey === "modified")).toMatchObject({ state: "modified" });
  expect(source.uses.find((use) => use.skillKey === "not-found")).toMatchObject({ state: "modified" });
  expect(source.uses.find((use) => use.skillKey === "modified")).not.toHaveProperty("lockStale");
  const update = source.uses.find((use) => use.skillKey === "update")!;
  metrics.commands = [];
  expect(await service.compare(update.id)).toMatchObject({
    status: "ready",
    base: { status: "found", commit: f.baseCommit },
  });
  expect(metrics.commands.filter((args) => args.includes("--format=%H"))).toHaveLength(0);
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(1);
  const currentHash = await folderHash(f.projectA, ".agents/skills/update");
  const entry = parseSkillsLock(JSON.parse(await readFile(`${f.projectA}/skills-lock.json`, "utf8"))).entries.find(
    (entry) => entry.skillKey === "update",
  )!;
  const reader = (copyHash: string, sourceSkillPath = entry.sourceSkillPath) =>
    createExternalProjectStateReader({
      userDataPath: f.data,
      projectId: "project-a",
      origins: [
        {
          ...entry,
          sourceSkillPath,
          artifactId: "update",
          relativePath: ".agents/skills/update/SKILL.md",
          lockPath: "skills-lock.json",
          verification: "modified",
          copyHash,
        },
      ],
    });
  metrics.commands = [];
  expect(await reader(currentHash)(".agents/skills/update")).toBe("update-available");
  expect(await reader("d".repeat(64))(".agents/skills/update")).toBe("modified-here");
  expect(await reader(currentHash, "skills/modified")(".agents/skills/update")).toBe("modified-here");
  expect(await reader(update.sourceHash!)(".agents/skills/update")).toBe("current");
  await service.list();
  await service.readSource("fixture/tools");
  await service.onMac();
  expect(metrics.commands).toEqual([]);
  expect(await Promise.all([f.projectA, f.projectB, f.home, f.folderSource].map(fingerprint))).toEqual(before);
}, 60000);

it("finds a previously unpublished copy when a new source commit publishes its bytes", async () => {
  const f = await externalLibraryFixture({ staleLocks: true });
  roots.push(f.root);
  const options = { userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl };
  await createExternalLibraryService(options).check();
  const text = await readFile(`${f.projectB}/.agents/skills/modified/SKILL.md`, "utf8");
  await write(f.upstream, "skills/modified/SKILL.md", text);
  const published = await commit(f.upstream);
  await write(f.upstream, "skills/modified/SKILL.md", "A newer source version.\n");
  await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  const service = createExternalLibraryService(options);
  await service.check();
  expect((await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "modified")).toMatchObject({
    state: "update",
    lockStale: true,
    installedCommit: published,
  });
}, 60000);

it("checks replacement history after a force push instead of reusing a miss from another lineage", async () => {
  const f = await externalLibraryFixture({ staleLocks: true });
  roots.push(f.root);
  const options = { userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl };
  await createExternalLibraryService(options).check();
  await git(f.upstream, "checkout", "--orphan", "replacement");
  await write(
    f.upstream,
    "skills/modified/SKILL.md",
    await readFile(`${f.projectB}/.agents/skills/modified/SKILL.md`, "utf8"),
  );
  const published = await commit(f.upstream);
  await write(f.upstream, "skills/modified/SKILL.md", "Replacement source head.\n");
  await commit(f.upstream);
  await git(f.upstream, "push", "--force", f.origin, "HEAD:main");
  const service = createExternalLibraryService(options);
  await service.check();
  expect((await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "modified")).toMatchObject({
    state: "update",
    lockStale: true,
    installedCommit: published,
  });
}, 60000);

it("reuses persistent matches and misses after restart and walks only new commits for a new HEAD", async () => {
  const f = await externalLibraryFixture({ staleLocks: true });
  roots.push(f.root);
  const options = { userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl };
  metrics.commands = [];
  await createExternalLibraryService(options).check();
  const firstPass = metrics.commands.length;
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(4);
  metrics.commands = [];
  metrics.requests = [];
  const service = createExternalLibraryService(options);
  await service.check();
  const secondPass = metrics.commands.length;
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(0);
  expect(metrics.commands.filter((args) => args.includes("--format=%H"))).toHaveLength(0);
  await write(f.upstream, "skills/modified/new.txt", "New source version.\n");
  const newCommit = await commit(f.upstream);
  await git(f.upstream, "push", f.origin, "main");
  metrics.commands = [];
  metrics.requests = [];
  await service.check();
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(2);
  const historyLogs = metrics.commands.filter((args) => args.includes("--format=%H"));
  expect(historyLogs).toHaveLength(2);
  expect(historyLogs.every((args) => args.includes(`^${f.removalCommit}`))).toBe(true);
  expect(metrics.requests.filter((expression) => expression.includes(":"))).toEqual([
    `${newCommit}:skills/modified`,
    `${newCommit}:skills/modified`,
  ]);
  const source = await service.readSource("fixture/tools");
  expect(source.uses.find((use) => use.skillKey === "update")).toMatchObject({
    state: "update",
    lockStale: true,
    installedCommit: f.baseCommit,
  });
  console.info(
    JSON.stringify({
      fixture: "E1 stale locks",
      firstPassGitProcesses: firstPass,
      secondPassGitProcesses: secondPass,
      firstPassHistoryWalks: 4,
      secondPassHistoryWalks: 0,
    }),
  );
}, 60000);
