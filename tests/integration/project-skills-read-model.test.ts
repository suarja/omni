import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { seedFixture, registerOperations, sourcePackage, treeDigest } from "./skill-adoption-fixture";
import { run } from "../ipc/apply-ipc-helpers";
import { parseProjectSkills } from "../../src/shared/project-skills-ipc";
import { externalLibraryFixture } from "../helpers/external-library-fixture";

it("keeps observed Git scope labels with spaces and nested roots valid in the project read model", () => {
  const git = [{ id: "git-My Project/nested", relativeRoot: "My Project/nested", branch: "main", dirty: false }];
  expect(
    parseProjectSkills({
      projectId: "project",
      skills: [],
      activeSkillCount: { "claude-code": 0, codex: 0 },
      startupCost: { "claude-code": 0, codex: 0 },
      diagnostics: [],
      git,
    }).git,
  ).toEqual(git);
});

it("reads the actual branch, commit and local changes without modifying the project or its Git metadata", async () => {
  const fixture = await seedFixture();
  await run("git", ["-C", fixture.projectRoot, "checkout", "-b", "main"]);
  await writeFile(join(fixture.projectRoot, "tracked.txt"), "initial\n");
  await run("git", ["-C", fixture.projectRoot, "add", "tracked.txt"]);
  await run("git", [
    "-C",
    fixture.projectRoot,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=ada@example.com",
    "commit",
    "-qm",
    "Seed tracked file",
  ]);
  const head = (await run("git", ["-C", fixture.projectRoot, "rev-parse", "HEAD"])).stdout.trim();
  const { skillManagement } = await registerOperations(fixture);
  const cleanBefore = await treeDigest(fixture.projectRoot);
  expect((await skillManagement.readProjectSkills!(fixture.project.id)).git).toContainEqual(
    expect.objectContaining({ branch: "main", head, dirty: false }),
  );
  expect(await treeDigest(fixture.projectRoot)).toBe(cleanBefore);
  await writeFile(join(fixture.projectRoot, "tracked.txt"), "local changes\n");
  const dirtyBefore = await treeDigest(fixture.projectRoot);
  expect((await skillManagement.readProjectSkills!(fixture.project.id)).git).toContainEqual(
    expect.objectContaining({ branch: "main", head, dirty: true }),
  );
  expect(await treeDigest(fixture.projectRoot)).toBe(dirtyBefore);
});

it("reads notes-app-shaped data as 59 logical skills with origins, agent links, descriptions, cost and located diagnostics", async () => {
  const fixture = await seedFixture();
  const records = [];
  const uses = [];
  const lock: Record<string, unknown> = Object.create(null);
  const writeSkill = async (name: string, harness: "claude-code" | "codex", link = false): Promise<string> => {
    const folder = `${harness === "codex" ? ".agents" : ".claude"}/skills/${name}`;
    await mkdir(join(fixture.projectRoot, folder, ".."), { recursive: true });
    if (link) await symlink(`../../.agents/skills/${name}`, join(fixture.projectRoot, folder));
    else {
      await mkdir(join(fixture.projectRoot, folder), { recursive: true });
      await writeFile(
        join(fixture.projectRoot, folder, "SKILL.md"),
        `---\nname: ${name}\ndescription: Description of ${name}.\n---\n# ${name}\n`,
      );
    }
    return folder;
  };
  for (let index = 0; index < 18; index++) {
    const name = index === 0 ? "demo" : `mine-${index}`;
    const skillId = randomUUID();
    const locations = [];
    for (const harnessId of ["claude-code", "codex"] as const) {
      const folderPath = await writeSkill(name, harnessId);
      const location = { projectId: fixture.project.id, harnessId, folderPath };
      locations.push(location);
      uses.push({
        skillId,
        bindingId: randomUUID(),
        location,
        source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: `skills/${name}` },
        baseRevisionId: randomUUID(),
        baseUnavailable: true as const,
      });
    }
    records.push({ skillId, label: name, evidence: "individual" as const, locations });
  }
  for (let index = 0; index < 34; index++) {
    const name = `external-${index}`;
    await writeSkill(name, "codex");
    await writeSkill(name, "claude-code", true);
    lock[name] = { source: `owner/source-${index % 5}`, sourceType: "github", computedHash: "a".repeat(64) };
  }
  for (const name of ["__proto__", "constructor", "prototype"]) {
    await writeSkill(name, "codex");
    lock[name] = { source: "owner/special", sourceType: "github", computedHash: "b".repeat(64) };
  }
  for (const name of ["local-a", "local-b", "blog-article-protocol", "remotion-best-practices"]) {
    if (name !== "remotion-best-practices") await writeSkill(name, "claude-code");
    if (name !== "blog-article-protocol") await writeSkill(name, "codex");
  }
  await writeFile(join(fixture.projectRoot, "skills-lock.json"), JSON.stringify({ version: 1, skills: lock }));
  await mkdir(join(fixture.projectRoot, ".cursor/skills"), { recursive: true });
  await symlink("missing", join(fixture.projectRoot, ".cursor/skills/broken"));
  const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
  expect(
    await relationships.updateUsesExact(
      0,
      uses.map((use) => ({ skillId: use.skillId, location: use.location, after: use })),
      records.map((record) => ({ skillId: record.skillId, after: record })),
    ),
  ).toMatchObject({ status: "saved" });
  const { skillManagement } = await registerOperations(fixture);
  const view = await skillManagement.readProjectSkills!(fixture.project.id);
  expect(view.skills).toHaveLength(59);
  expect(view.skills.filter((row) => row.origin.kind === "mine")).toHaveLength(18);
  expect(
    view.skills
      .filter((row) => row.origin.kind === "mine")
      .every((row) => row.origin.kind === "mine" && row.origin.label === "Tools"),
  ).toBe(true);
  const external = view.skills.filter((row) => row.origin.kind === "external");
  expect(external).toHaveLength(37);
  expect(external.map((row) => row.name)).toEqual(expect.arrayContaining(["__proto__", "constructor", "prototype"]));
  expect(new Set(external.map((row) => row.origin.kind === "external" && row.origin.source)).size).toBe(6);
  expect(
    external.filter((row) => row.name.startsWith("external-")).every((row) => row.agents["claude-code"].symlink),
  ).toBe(true);
  expect(
    external
      .filter((row) => ["__proto__", "constructor", "prototype"].includes(row.name))
      .every((row) => row.agents.codex.state === "installed"),
  ).toBe(true);
  expect(view.skills.filter((row) => row.origin.kind === "project-only")).toHaveLength(4);
  expect(view.skills.find((row) => row.name === "blog-article-protocol")?.agents.codex.state).toBe("absent");
  expect(view.skills.find((row) => row.name === "remotion-best-practices")?.agents["claude-code"].state).toBe("absent");
  expect(view.skills.find((row) => row.name === "external-0")?.description).toBe("Description of external-0.");
  expect(view.activeSkillCount).toEqual({ "claude-code": 55, codex: 58 });
  for (const harness of ["claude-code", "codex"] as const)
    expect(view.startupCost[harness]).toBe(
      Math.ceil(
        view.skills
          .filter((row) => row.agents[harness].state === "installed")
          .reduce((sum, row) => sum + row.name.length + row.description.length, 0) / 4,
      ),
    );
  expect(view.diagnostics).toContainEqual(
    expect.objectContaining({ location: ".cursor/skills/broken", code: "broken-link" }),
  );
});

it("counts the actual descriptions loaded by each agent when their copies differ", async () => {
  const fixture = await seedFixture();
  await writeFile(
    join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"),
    "---\nname: demo\ndescription: A longer Claude description.\n---\n",
  );
  await writeFile(
    join(fixture.projectRoot, ".agents/skills/demo/SKILL.md"),
    "---\nname: demo\ndescription: Codex.\n---\n",
  );
  const { skillManagement } = await registerOperations(fixture);
  const view = await skillManagement.readProjectSkills!(fixture.project.id);
  expect(view.skills).toHaveLength(1);
  expect(view.startupCost).toEqual({
    "claude-code": Math.ceil((4 + "A longer Claude description.".length) / 4),
    codex: Math.ceil((4 + "Codex.".length) / 4),
  });
});
it("reads external lock states into project rows without mutating either project", async () => {
  const f = await externalLibraryFixture();
  try {
    vi.doMock("electron", () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => f.data }, dialog: {} }));
    const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
    const { createProjectSkillParking } = await import("../../src/main/skill-management/project-skill-parking");
    const { registerRegistryIpcHandlers } = await import("../../src/main/registry-ipc");
    const registry = registerRegistryIpcHandlers(() => undefined, { userDataPath: f.data, registryStore: f.registry });
    const { createExternalLibraryService } = await import("../../src/main/external-library/service");
    const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    await service.check();
    const { readProjectSkills } = await import("../../src/main/skill-management/project-skills-reader");
    const dependencies = {
      userDataPath: f.data,
      registry,
      relationships: createSkillRelationshipStore(join(f.data, "omni/skill-relationships.json")),
      bases: createSkillBaseStore(f.data),
      parking: createProjectSkillParking(f.data),
    };
    const first = await readProjectSkills("project-a", dependencies);
    expect(first.skills.map((skill) => [skill.name, skill.state])).toEqual([
      ["current", "current"],
      ["removed", "removed-upstream"],
      ["update", "update-available"],
    ]);
    const second = await readProjectSkills("project-b", dependencies);
    expect(
      second.skills.filter((skill) => skill.name === "modified").every((skill) => skill.state === "modified-here"),
    ).toBe(true);
    expect(second.skills.find((skill) => skill.name === "other")?.state).toBe("current");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 60000);
