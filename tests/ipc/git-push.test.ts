import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";
import { systemGitCli } from "../../src/main/git-cli";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const exec = promisify(execFile);
it("pushes only a safe named branch to a local bare origin and reports failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-push-"));
  try {
    const repo = join(root, "repo");
    const origin = join(root, "origin.git");
    await mkdir(repo);
    await exec("git", ["init", "--bare", origin]);
    await writeFile(join(repo, "README.md"), "Fixture\n");
    const commit = await systemGitCli.initAndCommit(repo, "Fixture");
    await exec("git", ["remote", "add", "origin", origin], { cwd: repo });
    expect(await systemGitCli.remoteUrl(repo)).toBe(origin);
    const branch = (await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim();
    expect(await systemGitCli.push(repo, "origin", branch)).toEqual({ status: "pushed" });
    expect((await exec("git", ["rev-parse", `refs/heads/${branch}`], { cwd: origin })).stdout.trim()).toBe(
      commit.status === "committed" ? commit.commit : "missing",
    );
    expect(await systemGitCli.push(repo, "--all", branch)).toMatchObject({ status: "failed" });
    expect(await systemGitCli.push(repo, "origin", "main:other")).toMatchObject({ status: "failed" });
    await exec("git", ["remote", "set-url", "origin", join(root, "missing.git")], { cwd: repo });
    expect(await systemGitCli.push(repo, "origin", branch)).toMatchObject({
      status: "failed",
      diagnostic: expect.stringContaining("repository"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
