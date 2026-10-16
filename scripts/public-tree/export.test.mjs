import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicTree } from "./export.mjs";

const roots = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "public-export-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "scripts/public-tree"), { recursive: true });
  const git = (...args) =>
    execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args]);
  git("init", "-q");
  await writeFile(
    join(repo, "scripts/public-tree/manifest.json"),
    JSON.stringify({
      exclusions: ["private", ["scripts/public-tree", "private-terms.txt"].join("/")],
      imageAllowlist: [],
    }),
  );
  await writeFile(join(repo, ["scripts/public-tree", "private-terms.txt"].join("/")), "private-project\n");
  await writeFile(join(repo, "README.md"), "Committed content\n");
  await mkdir(join(repo, "private"));
  await writeFile(join(repo, "private/notes.md"), "private-project\n");
  git("add", ".");
  const commit = () =>
    git("-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", "Synthetic snapshot");
  commit();
  return { root, repo, target: join(root, "target"), git, commit };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("exports committed bytes only, applies committed exclusions and creates no Git history", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "README.md"), "Dirty bytes");
  await writeFile(join(f.repo, "untracked.txt"), "Untracked");
  await writeFile(join(f.repo, "scripts/public-tree/manifest.json"), "{}");
  expect(await exportPublicTree(f.repo, f.target)).toEqual({ fileCount: 2, findings: [] });
  expect(await readFile(join(f.target, "README.md"), "utf8")).toBe("Committed content\n");
  expect(await readdir(f.target)).toEqual(["README.md", "scripts"]);
});
it("refuses a non-empty destination and keeps its files intact", async () => {
  const f = await fixture();
  await mkdir(f.target);
  await writeFile(join(f.target, "keep.txt"), "Keep");
  await expect(exportPublicTree(f.repo, f.target)).rejects.toThrow(/empty/);
  expect(await readFile(join(f.target, "keep.txt"), "utf8")).toBe("Keep");
});
it("refuses symbolic destinations and paths inside the checkout", async () => {
  const f = await fixture();
  await expect(exportPublicTree(f.repo, join(f.repo, "export"))).rejects.toThrow(/outside/);
});
it("returns leak findings and leaves a failed export destination empty", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "README.md"), "PRIVATE-PROJECT\n");
  f.git("add", "README.md");
  f.commit();
  const result = await exportPublicTree(f.repo, f.target);
  expect(result.findings).toContainEqual(expect.objectContaining({ file: "README.md", line: 1, rule: "private-term" }));
  expect(await readdir(f.target)).toEqual([]);
});
it("rejects unsafe manifest exclusions before copying anything", async () => {
  const f = await fixture();
  await writeFile(
    join(f.repo, "scripts/public-tree/manifest.json"),
    JSON.stringify({ exclusions: ["../escape"], imageAllowlist: [] }),
  );
  f.git("add", "scripts/public-tree/manifest.json");
  f.commit();
  await expect(exportPublicTree(f.repo, f.target)).rejects.toThrow(/manifest/);
});
it("keeps archive substitutions and export-ignore from changing committed file bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, ".gitattributes"), "README.md export-subst\nkeep.txt export-ignore\n");
  await writeFile(join(f.repo, "README.md"), "$Format:%H$\n");
  await writeFile(join(f.repo, "keep.txt"), "Keep committed bytes\n");
  f.git("add", ".");
  f.commit();
  const result = await exportPublicTree(f.repo, f.target);
  expect(result.findings).toEqual([]);
  expect(await readFile(join(f.target, "README.md"), "utf8")).toBe("$Format:%H$\n");
  expect(await readFile(join(f.target, "keep.txt"), "utf8")).toBe("Keep committed bytes\n");
});
it("refuses nested destinations whose name starts with two dots", async () => {
  const f = await fixture();
  await expect(exportPublicTree(f.repo, join(f.repo, "..candidate"))).rejects.toThrow(/outside/);
});

it("accepts an empty target under a symlinked parent and refuses a symlink target", async () => {
  const f = await fixture();
  const parent = join(f.root, "parent");
  const alias = join(f.root, "alias");
  await mkdir(parent);
  await symlink(parent, alias);
  const target = join(alias, "nested", "target");
  expect((await exportPublicTree(f.repo, target)).findings).toEqual([]);
  await symlink(join(parent, "nested", "target"), join(f.root, "direct-link"));
  await expect(exportPublicTree(f.repo, join(f.root, "direct-link"))).rejects.toThrow(/symbolic/);
});
