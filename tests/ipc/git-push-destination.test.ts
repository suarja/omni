import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { systemGitCli } from "../../src/main/git-cli";
import { git } from "../helpers/publication-fixture";
import { resolveRepositoryPushUrl } from "../../src/main/git-push";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-push-target-"));
  roots.push(root);
  const repo = join(root, "repo"),
    origin = join(root, "origin.git");
  await mkdir(repo);
  await git(root, "init", "--bare", origin);
  await writeFile(join(repo, "README.md"), "Fixture\n");
  const result = await systemGitCli.initAndCommit(repo, "Fixture");
  if (result.status !== "committed") throw new Error(result.diagnostic);
  await git(repo, "remote", "add", "origin", origin);
  const branch = await git(repo, "branch", "--show-current");
  return { root, repo, origin, branch, commit: result.commit };
}
it("rejects multiple push URLs at the transfer boundary", async () => {
  const f = await fixture();
  const other = join(f.root, "other.git");
  await git(f.root, "init", "--bare", other);
  await git(f.repo, "config", "--add", "remote.origin.pushurl", f.origin);
  await git(f.repo, "config", "--add", "remote.origin.pushurl", other);
  expect(await systemGitCli.push(f.repo, "origin", f.branch)).toMatchObject({
    status: "failed",
    diagnostic: expect.stringContaining("multiple"),
  });
  for (const origin of [f.origin, other]) expect(await git(origin, "show-ref", "--heads").catch(() => "")).toBe("");
});
it("rejects a destination or commit that differs from the reviewed push target", async () => {
  const f = await fixture();
  for (const target of [
    { remoteUrl: join(f.root, "other.git"), commit: f.commit },
    { remoteUrl: f.origin, commit: "0".repeat(40) },
  ])
    expect(await systemGitCli.push(f.repo, "origin", f.branch, target)).toMatchObject({
      status: "failed",
      diagnostic: expect.stringContaining("changed"),
    });
  expect(await git(f.origin, "show-ref", "--heads").catch(() => "")).toBe("");
});
it("resolves longest URL rewrite prefixes and gives pushInsteadOf precedence", async () => {
  const f = await fixture();
  await git(f.repo, "config", "url./fixture/short/.insteadOf", "alias:");
  await git(f.repo, "config", "url./fixture/long/.insteadOf", "alias:long/");
  expect(await resolveRepositoryPushUrl(f.repo, "alias:long/demo.git")).toBe("/fixture/long/demo.git");
  await git(f.repo, "config", "url./fixture/push/.pushInsteadOf", "alias:");
  expect(await resolveRepositoryPushUrl(f.repo, "alias:long/demo.git")).toBe("/fixture/push/long/demo.git");
});
