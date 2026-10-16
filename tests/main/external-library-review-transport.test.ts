import { mkdir, mkdtemp, readdir, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  cloneExternalReadCopy,
  refreshExternalReadCopy,
  runGitCommand,
  classifyGitFailure,
} from "../../src/main/git-command";
import { readGitTextOrThrow } from "../../src/main/git-read";
import { git, write, commit } from "../helpers/publication-fixture";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("checks out only skill folders and root licences without running LFS filters, including after conversion", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-sparse-")));
  roots.push(root);
  const source = join(root, "source"),
    remote = join(root, "remote.git"),
    copy = join(root, "copy");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await write(source, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  await write(source, "skills/a/SKILL.md", "---\nname: a\n---\n");
  await write(
    source,
    "skills/a/pointer.bin",
    "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 100000000\n",
  );
  await write(source, "nested/[b]/SKILL.md", "---\nname: b\n---\n");
  await write(source, "LICENSE.md", "MIT License\n");
  await write(source, "media/large.bin", new Uint8Array(2 * 1024 * 1024));
  await write(source, "apps/site/index.ts", "A monorepo application");
  await commit(source);
  await git(root, "clone", "--bare", source, remote);
  await git(remote, "config", "uploadpack.allowFilter", "true");
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  const remoteUrl = `file://${remote}`;
  const config = join(root, "config");
  await write(root, "config", '[filter "lfs"]\n process = false\n smudge = false\n required = true\n');
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  await cloneExternalReadCopy(root, remoteUrl, copy);
  expect((await readdir(copy)).sort()).toEqual([".git", "LICENSE.md", "nested", "skills"]);
  expect(await readFile(join(copy, "skills/a/pointer.bin"), "utf8")).toContain("git-lfs.github.com");
  expect(await readFile(join(copy, "nested/[b]/SKILL.md"), "utf8")).toContain("name: b");
  await git(
    copy,
    "-c",
    "filter.lfs.process=",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.required=false",
    "sparse-checkout",
    "disable",
  );
  expect(await readdir(copy)).toContain("media");
  vi.unstubAllEnvs();
  await git(source, "rm", "-r", "nested");
  await write(source, "new/c/SKILL.md", "---\nname: c\n---\n");
  await commit(source);
  await git(source, "push", remote, "main");
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  await refreshExternalReadCopy(copy, remoteUrl);
  expect((await readdir(copy)).sort()).toEqual([".git", "LICENSE.md", "new", "skills"]);
}, 60000);
it("classifies transport and shared reader failures under a non-English user locale", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-locale-")));
  roots.push(root);
  vi.stubEnv("LANG", "fr_FR.UTF-8");
  vi.stubEnv("LC_ALL", "fr_FR.UTF-8");
  vi.stubEnv("LANGUAGE", "fr");
  for (const run of [runGitCommand, readGitTextOrThrow]) {
    const error = await run(root, ["ls-remote", join(root, "missing.git")]).catch((error) => error);
    expect(classifyGitFailure(error).type).toBe("not-found");
    expect(error.stderr.toString()).toContain("does not appear to be a git repository");
  }
});
