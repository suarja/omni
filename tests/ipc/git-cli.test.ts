import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitAll,
  enclosingRepository,
  hasChanges,
  initAndCommit,
  isGitAvailable,
  isRepositoryRoot,
} from "../../src/main/git-cli";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omni-git-cli-"));
  roots.push(path);
  return path;
}

async function installMutatingHook(target: string, hookName: string, paths: readonly string[]): Promise<string> {
  const hooksPath = join(target, ".hooks");
  const sentinelPath = join(hooksPath, `${hookName}.ran`);
  await mkdir(hooksPath, { recursive: true });
  const script = [
    "#!/bin/sh",
    `printf 'ran\\n' > '.hooks/${hookName}.ran'`,
    ...paths.map((path) => `printf 'hook mutation\\n' > '${path}'`),
    "",
  ].join("\n");
  const hookPath = join(hooksPath, hookName);
  await writeFile(hookPath, script, "utf8");
  await chmod(hookPath, 0o755);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", target, "config", "core.hooksPath", hooksPath]);
  return sentinelPath;
}

async function installFsmonitor(target: string): Promise<{ sentinelPath: string; commandPath: string }> {
  const sentinelPath = join(target, "fsmonitor-ran");
  const commandPath = join(target, "fsmonitor-hook");
  await writeFile(
    commandPath,
    ["#!/bin/sh", "printf 'ran\\n' > fsmonitor-ran", "printf 'token\\000/\\000'", ""].join("\n"),
    "utf8",
  );
  await chmod(commandPath, 0o755);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", target, "config", "core.fsmonitor", commandPath]);
  return { sentinelPath, commandPath };
}

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Git operation adapter", () => {
  it("detects a repository without writing when none exists", async () => {
    const target = await root();
    expect(await isGitAvailable()).toBe(true);
    await expect(enclosingRepository(target)).resolves.toEqual({ status: "none" });
  });

  it("initializes and commits exactly the target files", async () => {
    const target = await root();
    await writeFile(join(target, "README.md"), "created\n", "utf8");
    await expect(initAndCommit(target, "Create personal marketplace")).resolves.toMatchObject({
      status: "committed",
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    const result = await enclosingRepository(target);
    expect(result.status).toBe("repository");
    expect((await stat(join(target, ".git"))).isDirectory()).toBe(true);
    expect(await readFile(join(target, ".git", "HEAD"), "utf8")).toContain("refs/heads/");
  });

  it("commits only the explicitly affected paths and detects the repository root", async () => {
    const target = await root();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", target]);
    await writeFile(join(target, "one.txt"), "one\n", "utf8");
    await writeFile(join(target, "two.txt"), "two\n", "utf8");
    expect(await isRepositoryRoot(target)).toBe(true);
    await expect(commitAll(target, "Import one", ["one.txt"])).resolves.toMatchObject({
      status: "committed",
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(
      execFileSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: target, encoding: "utf8" }),
    ).toContain("one.txt");
    expect(execFileSync("git", ["status", "--short"], { cwd: target, encoding: "utf8" })).toContain("?? two.txt");
  });

  it("leaves the user's staged changes out of Omni's commit", async () => {
    const target = await root();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", target]);
    await writeFile(join(target, "mine.txt"), "mine\n", "utf8");
    execFileSync("git", ["-C", target, "add", "--", "mine.txt"]);
    await writeFile(join(target, "omni.txt"), "omni\n", "utf8");
    await expect(commitAll(target, "Add omni", ["omni.txt"])).resolves.toMatchObject({ status: "committed" });
    expect(
      execFileSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: target, encoding: "utf8" }).trim(),
    ).toBe("omni.txt");
    expect(execFileSync("git", ["status", "--short"], { cwd: target, encoding: "utf8" })).toContain("A  mine.txt");
  });

  it("does not run configured hooks or let them alter previewed and staged files", async () => {
    const target = await root();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", target]);
    await writeFile(join(target, "mine.txt"), "mine staged\n", "utf8");
    execFileSync("git", ["-C", target, "add", "--", "mine.txt"]);
    await writeFile(join(target, "omni.txt"), "previewed bytes\n", "utf8");
    const preCommitSentinel = await installMutatingHook(target, "pre-commit", ["omni.txt", "mine.txt"]);
    const indexSentinel = await installMutatingHook(target, "post-index-change", ["omni.txt", "mine.txt"]);
    await expect(readFile(indexSentinel, "utf8")).rejects.toThrow();

    await expect(commitAll(target, "Add omni", ["omni.txt"])).resolves.toMatchObject({ status: "committed" });

    await expect(readFile(preCommitSentinel, "utf8")).rejects.toThrow();
    await expect(readFile(indexSentinel, "utf8")).rejects.toThrow();
    expect(await readFile(join(target, "omni.txt"), "utf8")).toBe("previewed bytes\n");
    expect(await readFile(join(target, "mine.txt"), "utf8")).toBe("mine staged\n");
    expect(
      execFileSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: target, encoding: "utf8" }).trim(),
    ).toBe("omni.txt");
    expect(execFileSync("git", ["status", "--short"], { cwd: target, encoding: "utf8" })).toContain("A  mine.txt");
    expect(
      execFileSync("git", ["-C", target, "config", "--local", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(),
    ).toBe(join(target, ".hooks"));
  });

  it("does not run a configured pre-commit hook from initAndCommit", async () => {
    const target = await root();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", target]);
    const sentinelPath = await installMutatingHook(target, "pre-commit", ["README.md"]);
    await writeFile(join(target, "README.md"), "previewed bytes\n", "utf8");

    await expect(initAndCommit(target, "Create personal marketplace")).resolves.toMatchObject({ status: "committed" });

    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("previewed bytes\n");
  });

  it("disables a configured fsmonitor for status without changing its repository setting", async () => {
    const target = await root();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", target]);
    const filePath = join(target, "tracked.txt");
    await writeFile(filePath, "before\n", "utf8");
    execFileSync("git", ["-C", target, "add", "--", "tracked.txt"]);
    const fsmonitor = await installFsmonitor(target);
    await writeFile(filePath, "after\n", "utf8");

    await expect(hasChanges(target, ["tracked.txt"])).resolves.toBe(true);

    await expect(readFile(fsmonitor.sentinelPath, "utf8")).rejects.toThrow();
    expect(
      execFileSync("git", ["-C", target, "config", "--local", "--get", "core.fsmonitor"], { encoding: "utf8" }).trim(),
    ).toBe(fsmonitor.commandPath);
  });
});
