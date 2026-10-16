import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, readFile, readdir, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarketplaceManifest, parsePackageManifest } from "../../src/domain/marketplace-format";
import { createDemoProfile } from "./profile.mjs";

const roots = [];
async function temporary() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "demo-profile-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
it("creates synthetic projects, four plugins and an empty Omni profile", async () => {
  const root = await temporary();
  await createDemoProfile(root);
  expect(await readdir(join(root, "userData"))).toEqual([]);
  expect((await readdir(join(root, "projects"))).sort()).toEqual(["acme-web", "acme-workspace", "notes-app"]);
  for (const name of ["acme-web", "notes-app", "acme-workspace"]) {
    const project = join(root, "projects", name);
    expect(git(project, "log", "-1", "--format=%an <%ae>")).toBe("Ada Example <ada@example.com>");
    expect(git(project, "status", "--porcelain")).toBe("");
    expect(await readFile(join(project, "package.json"), "utf8")).toContain(name);
    expect(await readFile(join(project, "AGENTS.md"), "utf8")).toContain("synthetic");
  }
  const marketplace = join(root, "acme-skills");
  const manifest = JSON.parse(await readFile(join(marketplace, "omni.marketplace.json"), "utf8"));
  expect(parseMarketplaceManifest(manifest)).toEqual(manifest);
  expect(manifest.name).toBe("acme-skills");
  expect(manifest.packages).toHaveLength(4);
  for (const entry of manifest.packages) {
    const plugin = JSON.parse(await readFile(join(marketplace, entry.path, "omni.plugin.json"), "utf8"));
    expect(parsePackageManifest(plugin)).toEqual(plugin);
    expect(plugin.artifacts.length).toBeGreaterThan(0);
    for (const artifact of plugin.artifacts)
      expect(await readFile(join(marketplace, entry.path, artifact.path, "SKILL.md"), "utf8")).toContain(
        "description:",
      );
  }
  expect(JSON.parse(await readFile(join(root, "home/.claude.json"), "utf8"))).toEqual({ mcpServers: {} });
  expect(await readFile(join(root, "home/.codex/config.toml"), "utf8")).toContain("Synthetic");
});
it("refuses nonempty destinations without changing existing files", async () => {
  const root = await temporary();
  await writeFile(join(root, "keep.txt"), "keep");
  await expect(createDemoProfile(root)).rejects.toThrow(/empty/);
  expect(await readdir(root)).toEqual(["keep.txt"]);
});
it("refuses a symbolic-link destination or ancestor", async () => {
  const root = await temporary();
  const target = join(root, "target");
  await mkdir(target);
  await symlink(target, join(root, "link"));
  await expect(createDemoProfile(join(root, "link"))).rejects.toThrow(/symbolic/);
  await expect(createDemoProfile(join(root, "link", "child"))).rejects.toThrow(/symbolic/);
  expect(await readdir(target)).toEqual([]);
});
it("creates a missing target and refuses a second generation", async () => {
  const parent = await temporary();
  const root = join(parent, "demo");
  await createDemoProfile(root);
  await expect(createDemoProfile(root)).rejects.toThrow(/empty/);
});
it("ignores inherited Git identity, hooks, templates and repository redirects", async () => {
  const root = await temporary();
  const outside = await temporary();
  const hook = join(outside, "hooks");
  await mkdir(hook);
  await writeFile(join(hook, "post-commit"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const template = join(outside, "template");
  await mkdir(template);
  await writeFile(join(template, "private-template"), "must not copy");
  const config = join(outside, "gitconfig");
  await writeFile(
    config,
    `[user]\n name = Other\n email = other@example.com\n[core]\n hooksPath = ${hook}\n[init]\n templateDir = ${template}\n[commit]\n gpgsign = true\n`,
  );
  const saved = { ...process.env };
  try {
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_DIR = join(outside, "redirect.git");
    process.env.GIT_AUTHOR_NAME = "Other";
    process.env.GIT_AUTHOR_EMAIL = "other@example.com";
    await createDemoProfile(root);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  expect(git(join(root, "projects/acme-web"), "log", "-1", "--format=%an <%ae>")).toBe("Ada Example <ada@example.com>");
  expect(await readdir(outside)).toEqual(expect.not.arrayContaining(["redirect.git"]));
  expect(await readdir(join(root, "projects/acme-web/.git"))).not.toContain("private-template");
});

it("refuses missing arguments and file destinations", async () => {
  await expect(createDemoProfile("")).rejects.toThrow(/empty demo directory/);
  const root = await temporary();
  const file = join(root, "file");
  await writeFile(file, "keep");
  await expect(createDemoProfile(file)).rejects.toThrow(/not a directory/);
  expect(await readFile(file, "utf8")).toBe("keep");
});
