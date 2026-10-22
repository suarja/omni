import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readInstalledWorkshopPlugins } from "../../src/main/workshop-delivery/installed-plugins";
import { runGitCommand as git } from "../../src/main/git-command";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-installed-plugins-"));
  roots.push(root);
  const home = join(root, "home"),
    workshop = join(root, "workshop");
  async function write(path: string, value: unknown) {
    const target = join(root, path);
    await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
  }
  await write("workshop/.claude-plugin/marketplace.json", {
    name: "fixture",
    plugins: [{ name: "truth", source: "./truth" }],
  });
  await write("workshop/.agents/plugins/marketplace.json", {
    name: "fixture",
    plugins: [{ name: "truth", source: "./truth" }],
  });
  await write("workshop/truth/.claude-plugin/plugin.json", { name: "truth", version: "2.0.0" });
  await write("workshop/truth/.codex-plugin/plugin.json", { name: "truth", version: "2.0.0" });
  await git(workshop, ["init", "-b", "main"]);
  await git(workshop, ["add", "."]);
  await git(workshop, ["-c", "user.name=Example", "-c", "user.email=ada@example.com", "commit", "-m", "fixture"]);
  const pushedCommit = await git(workshop, ["rev-parse", "HEAD"]);
  await write("home/.claude/plugins/known_marketplaces.json", {
    fixture: { source: { source: "github", repo: "example/workshop" } },
    other: { source: { source: "github", repo: "example/other" } },
  });
  await write("home/.claude/plugins/installed_plugins.json", {
    version: 2,
    plugins: {
      "truth@fixture": [{ scope: "user", version: "1.0.0", gitCommitSha: "a".repeat(40) }],
      "truth@other": [{ scope: "user", version: "1.0.0", gitCommitSha: "a".repeat(40) }],
    },
  });
  await write(
    "home/.codex/config.toml",
    '[marketplaces.fixture]\nsource_type = "git"\nsource = "https://github.com/example/workshop.git"\n\n[plugins."truth@fixture"]\nenabled = true\n',
  );
  await write("home/.codex/plugins/cache/fixture/truth/1.0.0/.codex-plugin/plugin.json", {
    name: "truth",
    version: "1.0.0",
  });
  return { root, home, workshop, write, pushedCommit };
}
it("compares both harnesses with the pushed catalogue and gives verified scoped commands", async () => {
  const f = await fixture();
  const result = await readInstalledWorkshopPlugins({ ...f, repository: "example/workshop" });
  expect(result.behind).toBe(2);
  expect(result.installations).toHaveLength(2);
  expect(result.installations[0]?.commands).toContainEqual({
    executable: "claude",
    args: ["plugin", "update", "truth@fixture", "--scope", "user", "--json"],
  });
  expect(result.installations[1]?.commands).toContainEqual({
    executable: "codex",
    args: ["plugin", "add", "truth@fixture", "--json"],
  });
});
it("does not use unpushed versions to label installed plugins behind", async () => {
  const f = await fixture();
  await f.write("workshop/truth/.claude-plugin/plugin.json", { name: "truth", version: "3.0.0" });
  await f.write("home/.claude/plugins/installed_plugins.json", {
    version: 2,
    plugins: { "truth@fixture": [{ scope: "user", version: "2.0.0", gitCommitSha: f.pushedCommit }] },
  });
  const result = await readInstalledWorkshopPlugins({ ...f, repository: "example/workshop" });
  expect(result.installations.find((p) => p.harness === "claude-code")?.state).toBe("current");
});
it("keeps malformed and missing revision evidence visible", async () => {
  const f = await fixture();
  await f.write("home/.codex/config.toml", '[plugins."truth@fixture"]\nenabled = ???');
  await f.write("home/.claude/plugins/installed_plugins.json", {
    version: 2,
    plugins: { "truth@fixture": [{ scope: "user", version: "2.0.0" }] },
  });
  const result = await readInstalledWorkshopPlugins({ ...f, repository: "example/workshop" });
  expect(result.installations[0]?.state).toBe("unknown");
  expect(result.status).toBe("partial");
  expect(result.diagnostics.length).toBeGreaterThan(0);
});
