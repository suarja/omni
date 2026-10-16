import { execFile as nodeExecFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanWorktrees } from "../../src/main/activity-worktrees";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];

async function createRepo(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), "omni-activity-worktrees-"));
  roots.push(root);
  await execFile("git", ["init", "-q"], { cwd: root });
  await execFile("git", ["config", "user.email", "ada@example.com"], { cwd: root });
  await execFile("git", ["config", "user.name", "Omni Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "root\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: root });
  await execFile("git", ["commit", "-q", "-m", "root"], { cwd: root });
  const worktree = join(root, ".worktrees", "feature-one");
  await mkdir(join(root, ".worktrees"), { recursive: true });
  await execFile("git", ["worktree", "add", "-q", "-b", "feature/one", worktree], { cwd: root });
  return { root, worktree };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("activity worktree inventory", () => {
  it("lists the main checkout and a clean real Git worktree", async () => {
    const { root } = await createRepo();
    const result = await scanWorktrees([{ projectId: "project-one", projectName: "Project One", root }], {
      now: Date.now(),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "project-one",
          projectName: "Project One",
          id: "main",
          kind: "git-worktree",
          isMain: true,
        }),
        expect.objectContaining({
          projectId: "project-one",
          projectName: "Project One",
          id: [".worktrees", "feature-one"].join("/"),
          branch: "feature/one",
          dirty: false,
          isMain: false,
        }),
      ]),
    );
  });

  it("marks a worktree with uncommitted changes as dirty", async () => {
    const { root, worktree } = await createRepo();
    await writeFile(join(worktree, "dirty.txt"), "changes\n", "utf8");

    const result = await scanWorktrees([{ projectId: "project-one", root }], { now: Date.now() });

    expect(result.find((item) => item.id === [".worktrees", "feature-one"].join("/"))).toMatchObject({ dirty: true });
  });

  it("does not invoke a configured fsmonitor while inspecting worktree status", async () => {
    const { root } = await createRepo();
    const commandPath = join(root, "fsmonitor-hook");
    const sentinelPath = join(root, "fsmonitor-ran");
    await writeFile(
      commandPath,
      ["#!/bin/sh", `printf 'ran\\n' > '${sentinelPath}'`, "printf 'token\\000/\\000'", ""].join("\n"),
      "utf8",
    );
    await chmod(commandPath, 0o755);
    await execFile("git", ["config", "core.fsmonitor", commandPath], { cwd: root });

    const result = await scanWorktrees([{ projectId: "project-one", root }], { now: Date.now() });

    expect(result.find((item) => item.id === [".worktrees", "feature-one"].join("/"))).toMatchObject({ dirty: false });
    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
    const configuredCommand = await execFile("git", ["config", "--local", "--get", "core.fsmonitor"], {
      cwd: root,
    });
    expect(configuredCommand.stdout.trim()).toBe(commandPath);
  });

  it("omits a worktree container when Git already reports its nested worktree", async () => {
    const { root } = await createRepo();
    const nestedWorktree = join(root, ".worktrees", "feat", "nested");
    await mkdir(join(root, ".worktrees", "feat"), { recursive: true });
    await execFile("git", ["worktree", "add", "-q", "-b", "feature/nested", nestedWorktree], { cwd: root });

    const result = await scanWorktrees([{ projectId: "project-one", root }], { now: Date.now() });

    expect(result.filter((item) => item.id === [".worktrees", "feat"].join("/"))).toHaveLength(0);
    expect(result.filter((item) => item.id === [".worktrees", "feat/nested"].join("/"))).toHaveLength(1);
  });

  it("links a Claude agent worktree to the running session subagent evidence", async () => {
    const { root } = await createRepo();
    const worktree = join(root, ".claude", "worktrees", "agent-abc");
    const transcriptDirectory = join(root, "claude-project-slug");
    await mkdir(worktree, { recursive: true });
    await mkdir(join(transcriptDirectory, "session-1", "subagents"), { recursive: true });
    await writeFile(join(transcriptDirectory, "session-1", "subagents", "agent-abc.jsonl"), "{}\n", "utf8");

    const result = await scanWorktrees([{ projectId: "project-one", root }], {
      now: Date.now(),
      claudeSessions: [{ sessionId: "session-1", cwd: root, transcriptDirectory }],
    });

    expect(result.find((item) => item.id === ".claude/worktrees/agent-abc")).toMatchObject({
      sessionId: "claude-code:session-1",
    });
  });
});
