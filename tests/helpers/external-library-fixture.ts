import { cp, mkdir, mkdtemp, readFile, realpath, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";
import { hashSkillFolder } from "../../src/adapters/inventory/skill-folder-hash";
import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import { registerProject, registerSource } from "../../src/domain/project-source-registry";
import { git, write, commit } from "./publication-fixture";
export const E1_TIME = "2026-10-12T12:00:00.000Z";
export async function folderHash(root: string, path: string): Promise<string> {
  const result = await hashSkillFolder(createLocalInventoryPort(root), path, { remainingBytes: 32 * 1024 * 1024 });
  if (result.status !== "hashed") throw new Error("Fixture cannot be hashed.");
  return result.hash;
}
export async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (path: string): Promise<void> => {
    for (const name of (await readdir(join(root, path))).sort()) {
      const child = path ? `${path}/${name}` : name;
      const details = await lstat(join(root, child));
      hash.update(child);
      if (details.isDirectory()) await visit(child);
      else hash.update(await readFile(join(root, child)));
    }
  };
  await visit("");
  return hash.digest("hex");
}
export async function externalLibraryFixture(options: Readonly<{ staleLocks?: boolean }> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-library-")));
  const data = join(root, "profile"),
    home = join(root, "home");
  const registry = createLocalJsonRegistryStore(join(data, "omni/project-source-registry.json"));
  const remote = new Map<string, string>();
  const upstream = join(root, "upstream");
  const projectA = join(root, "project-a"),
    projectB = join(root, "project-b");
  for (const path of [upstream, projectA, projectB]) await mkdir(path);
  await git(upstream, "init", "-b", "main");
  for (const name of ["current", "update", "modified", "removed", "unused"])
    await write(
      upstream,
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n\nBase ${name}.\n`,
    );
  await write(upstream, "skills/modified/binary.bin", new Uint8Array([0, 255, 1]));
  await write(upstream, "LICENSE", "MIT License\n");
  const baseCommit = await commit(upstream, "Install base");
  const hashes = Object.fromEntries(
    await Promise.all(
      ["current", "update", "modified", "removed"].map(async (name) => [
        name,
        await folderHash(upstream, `skills/${name}`),
      ]),
    ),
  );
  for (const [project, names] of [
    [projectA, ["current", "update", "removed"]],
    [projectB, ["modified", "not-found"]],
  ] as const) {
    for (const name of names) {
      const source = name === "not-found" ? "modified" : name;
      await mkdir(join(project, ".agents/skills"), { recursive: true });
      await cp(join(upstream, `skills/${source}`), join(project, `.agents/skills/${name}`), { recursive: true });
    }
    await write(
      project,
      "skills-lock.json",
      JSON.stringify({
        version: 1,
        skills: Object.fromEntries(
          names.map((name) => [
            name,
            {
              source: "fixture/tools",
              sourceType: "github",
              skillPath: `skills/${name === "not-found" ? "modified" : name}`,
              computedHash: name === "not-found" ? "f".repeat(64) : hashes[name],
            },
          ]),
        ),
      }),
    );
  }
  await write(
    projectB,
    ".agents/skills/modified/SKILL.md",
    "---\nname: modified\ndescription: Local description.\n---\n\nLocal.\n",
  );
  await write(projectB, ".agents/skills/not-found/local.txt", "This copy was never published.\n");
  if (options.staleLocks) {
    const lock = JSON.parse(await readFile(join(projectA, "skills-lock.json"), "utf8"));
    for (const name of ["current", "update", "removed"]) lock.skills[name].computedHash = "e".repeat(64);
    await write(projectA, "skills-lock.json", JSON.stringify(lock));
  }
  await write(upstream, "skills/update/SKILL.md", "---\nname: update\ndescription: Latest upstream.\n---\n\nNext.\n");
  await write(
    upstream,
    "skills/modified/SKILL.md",
    "---\nname: modified\ndescription: Upstream description.\n---\n\nUpstream.\n",
  );
  await git(upstream, "rm", "-r", "skills/removed");
  const removalCommit = await commit(upstream, "Remove retired skill");
  const origin = join(root, "tools.git");
  await git(root, "clone", "--bare", upstream, origin);
  remote.set("fixture/tools", origin);
  const second = join(root, "second");
  await mkdir(second);
  await git(second, "init", "-b", "main");
  await write(second, "LICENSE", "Apache License\nVersion 2.0, January 2004\n");
  await write(second, "nested/other/SKILL.md", "---\nname: other\ndescription: Other skill.\n---\n");
  await commit(second);
  const secondOrigin = join(root, "other.git");
  await git(root, "clone", "--bare", second, secondOrigin);
  remote.set("fixture/other", secondOrigin);
  await cp(join(second, "nested/other"), join(projectB, ".agents/skills/other"), { recursive: true });
  const secondLock = JSON.parse(await readFile(join(projectB, "skills-lock.json"), "utf8"));
  secondLock.skills.other = {
    source: "fixture/other",
    sourceType: "github",
    computedHash: await folderHash(second, "nested/other"),
  };
  await write(projectB, "skills-lock.json", JSON.stringify(secondLock));
  const folderSource = join(root, "folder-source");
  await mkdir(folderSource);
  await write(folderSource, "local/SKILL.md", "---\nname: local\ndescription: Folder skill.\n---\n");
  for (const [id, path] of [
    ["project-a", projectA],
    ["project-b", projectB],
  ]) {
    const loaded = await registry.read();
    if (loaded.status !== "ready") throw new Error("Registry unavailable.");
    await registry.mutate(
      loaded.state.revision,
      (state) => registerProject(state, { id, displayName: id, canonicalPath: path!, createdAt: E1_TIME }).nextState,
    );
  }
  const loaded = await registry.read();
  if (loaded.status !== "ready") throw new Error("Registry unavailable.");
  await registry.mutate(
    loaded.state.revision,
    (state) =>
      registerSource(state, {
        id: "folder",
        displayName: "Folder",
        canonicalPath: folderSource,
        createdAt: E1_TIME,
        ownership: "external",
      }).nextState,
  );
  await write(
    home,
    ".claude/plugins/known_marketplaces.json",
    JSON.stringify({
      tools: { source: { source: "github", repo: "fixture/tools" }, installLocation: "/never/read/cache" },
      other: { source: { source: "github", repo: "fixture/other" } },
    }),
  );
  await write(home, ".claude/plugins/cache/private.txt", "Do not inspect plugin content.");
  return {
    root,
    data,
    home,
    registry,
    upstream,
    origin,
    projectA,
    projectB,
    folderSource,
    baseCommit,
    removalCommit,
    resolveUrl: (repo: string) => remote.get(repo) ?? join(root, "missing.git"),
  };
}
