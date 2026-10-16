import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import * as gitRead from "../../src/main/git-read";
import { cloneExternalReadCopy } from "../../src/main/git-command";
import * as childProcess from "node:child_process";
import { readExternalBase } from "../../src/main/external-library/use-reader";
import { folderHash } from "../helpers/external-library-fixture";
import { git, write, commit } from "../helpers/publication-fixture";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("hashes identical historical subtrees once through one batch process", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-history-")));
  roots.push(root);
  await mkdir(join(root, "source"));
  const source = join(root, "source");
  await git(source, "init", "-b", "main");
  await write(source, "skills/a/SKILL.md", "base");
  const base = await commit(source),
    hash = await folderHash(source, "skills/a");
  await write(source, "skills/a/SKILL.md", "next");
  await commit(source);
  await write(source, "skills/a/SKILL.md", "base");
  await commit(source);
  await write(source, "skills/a/SKILL.md", "next");
  await commit(source);
  metrics.commands = [];
  metrics.requests = [];
  const result = await readExternalBase(source, "skills/a", "f".repeat(64));
  expect(result).toMatchObject({ status: "not-found", scanned: 4, bounded: false });
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(1);
  expect(metrics.commands.filter((args) => args.includes("show"))).toHaveLength(0);
  expect(metrics.commands.length).toBeLessThanOrEqual(3);
  expect(metrics.requests.filter((request) => /^[0-9a-f]{40}$/u.test(request))).toHaveLength(2);
  expect(await readExternalBase(source, "skills/a", hash)).toMatchObject({ status: "found", scanned: 2 });
  expect(base).toHaveLength(40);
}, 60000);
it("returns typed bounded not-found when the history wall-clock budget is exhausted", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-timeout-")));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await write(root, "skills/a/SKILL.md", "base");
  await commit(root);
  expect(await readExternalBase(root, "skills/a", "f".repeat(64), 300, { timeoutMs: 0 })).toMatchObject({
    status: "not-found",
    bounded: true,
    reason: "timeout",
  });
});

it("terminates a stalled batch reader within the history deadline", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-stalled-")));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await write(root, "skills/a/SKILL.md", "base");
  await commit(root);
  const spawn = childProcess.spawn;
  let killed: import("node:child_process").ChildProcess | undefined;
  const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    if (args[1]?.includes("cat-file")) {
      killed = child;
      vi.spyOn(child.stdin!, "write").mockImplementation(() => true);
    }
    return child;
  }) as typeof spawn);
  try {
    expect(await readExternalBase(root, "skills/a", "f".repeat(64), 300, { timeoutMs: 500 })).toMatchObject({
      status: "not-found",
      bounded: true,
      reason: "timeout",
    });
    expect(killed?.signalCode).toBe("SIGKILL");
  } finally {
    spy.mockRestore();
  }
}, 60000);

it("falls back to the bounded batch reader when bulk prefetch is unsupported", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-prefetch-fallback-")));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await write(root, "skills/a/SKILL.md", "base");
  const base = await commit(root),
    hash = await folderHash(root, "skills/a");
  const prefetch = vi
    .spyOn(gitRead, "prefetchGitTreeBlobs")
    .mockRejectedValue(new Error("The server does not allow bulk object wants."));
  try {
    expect(await readExternalBase(root, "skills/a", hash)).toMatchObject({ status: "found", commit: base });
  } finally {
    prefetch.mockRestore();
  }
});
it("prefetches missing historical blobs of a partial clone in one transfer", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-partial-history-")));
  roots.push(root);
  const source = join(root, "source"),
    remote = join(root, "remote.git"),
    copy = join(root, "copy");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await write(source, "skills/a/SKILL.md", "base");
  const base = await commit(source),
    hash = await folderHash(source, "skills/a");
  await write(source, "skills/a/SKILL.md", "next");
  await commit(source);
  await git(root, "clone", "--bare", source, remote);
  await git(remote, "config", "uploadpack.allowFilter", "true");
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  await cloneExternalReadCopy(root, `file://${remote}`, copy);
  metrics.commands = [];
  expect(await readExternalBase(copy, "skills/a", hash)).toMatchObject({ status: "found", commit: base });
  expect(metrics.commands.filter((args) => args.includes("fetch"))).toHaveLength(1);
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(1);
}, 60000);
