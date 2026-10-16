import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { instrumentGitProcesses } from "../helpers/git-process-metrics";
const metrics = vi.hoisted(() => ({ commands: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) =>
  instrumentGitProcesses(await importOriginal(), (args) => metrics.commands.push([...args])),
);
import { prefetchGitTreeBlobs, readGitTextOrThrow } from "../../src/main/git-read";
import { recoverExternalBase } from "../../src/main/external-library/base-recovery";
import { folderHash } from "../helpers/external-library-fixture";
import { git, write, commit } from "../helpers/publication-fixture";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function partialClone() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-promisor-")));
  roots.push(root);
  const source = join(root, "source"),
    remote = join(root, "remote.git"),
    copy = join(root, "copy");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await write(source, "skills/a/SKILL.md", "Base.\n");
  await write(source, "skills/a/nested/guide.md", "Base guide.\n");
  const base = await commit(source),
    hash = await folderHash(source, "skills/a");
  await write(source, "skills/a/SKILL.md", "Next.\n");
  await write(source, "skills/a/nested/guide.md", "Next guide.\n");
  await commit(source);
  await git(root, "clone", "--bare", source, remote);
  await git(remote, "config", "uploadpack.allowFilter", "true");
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  await git(root, "clone", "--filter=blob:none", "--no-checkout", `file://${remote}`, copy);
  const tree = (await readGitTextOrThrow(copy, ["rev-parse", `${base}:skills/a`]))!;
  const headTree = (await readGitTextOrThrow(copy, ["rev-parse", "HEAD:skills/a"]))!;
  const missing = await readGitTextOrThrow(copy, ["rev-list", "--objects", "--missing=print", "HEAD"]);
  expect(missing?.split(/\r?\n/u).filter((line) => line.startsWith("?"))).toHaveLength(4);
  return { copy, base, hash, tree, headTree };
}
it("walks an unprimed partial clone with one bulk fetch and no internal per-blob fetch", async () => {
  const f = await partialClone();
  vi.stubEnv("GIT_TRACE", "1");
  vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
  const process = await import("node:child_process");
  const stderr: string[] = [],
    spawn = process.spawn;
  vi.spyOn(process, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    child.stderr?.on("data", (bytes: Buffer) => stderr.push(bytes.toString()));
    return child;
  }) as typeof spawn);
  metrics.commands = [];
  expect((await recoverExternalBase(f.copy, "skills/a", f.hash)).base).toMatchObject({
    status: "found",
    commit: f.base,
  });
  expect(metrics.commands.filter((args) => args.includes("fetch"))).toHaveLength(1);
  expect(metrics.commands.filter((args) => args.includes("cat-file"))).toHaveLength(1);
  expect(stderr.join("")).not.toMatch(/run_command:.*\bfetch\b/u);
}, 60000);
it("uses one promisor bulk fetch and reads historical blobs with lazy fetch disabled", async () => {
  const f = await partialClone();
  vi.stubEnv("GIT_TRACE", "1");
  metrics.commands = [];
  await prefetchGitTreeBlobs(f.copy, [f.tree, f.headTree], 30000);
  const fetches = metrics.commands.filter((args) => args.includes("fetch"));
  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toEqual(
    expect.arrayContaining([
      "fetch.negotiationAlgorithm=noop",
      "origin",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
    ]),
  );
  // Git trace catches internal promisor subprocesses that the JavaScript runner cannot count.
  const process = await import("node:child_process");
  const stderr: string[] = [];
  const spawn = process.spawn;
  vi.spyOn(process, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    child.stderr?.on("data", (bytes: Buffer) => stderr.push(bytes.toString()));
    return child;
  }) as typeof spawn);
  vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
  expect((await recoverExternalBase(f.copy, "skills/a", f.hash)).base).toMatchObject({
    status: "found",
    commit: f.base,
  });
  expect(stderr.join("")).not.toMatch(/run_command:.*\bfetch\b/u);
  expect(metrics.commands.filter((args) => args.includes("fetch"))).toHaveLength(1);
  vi.restoreAllMocks();
}, 60000);
it("keeps valid tree blobs in the prefetch list when another tree is unavailable", async () => {
  const f = await partialClone();
  await expect(prefetchGitTreeBlobs(f.copy, ["f".repeat(40), f.tree], 30000)).resolves.toBeUndefined();
  vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
  expect((await recoverExternalBase(f.copy, "skills/a", f.hash)).base.status).toBe("found");
}, 60000);
