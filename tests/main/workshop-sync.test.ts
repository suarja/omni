import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runGitCommand as git } from "../../src/main/git-command";
import { readWorkshopSync, pushWorkshop } from "../../src/main/workshop-delivery/sync";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-workshop-sync-"));
  roots.push(root);
  const remote = join(root, "remote.git"),
    workshop = join(root, "workshop");
  await mkdir(workshop);
  await git(root, ["init", "--bare", remote]);
  await git(workshop, ["init", "-b", "main"]);
  await git(workshop, ["config", "user.name", "Example"]);
  await git(workshop, ["config", "user.email", "ada@example.com"]);
  const commit = async (name: string) => {
    await writeFile(join(workshop, name), name);
    await git(workshop, ["add", "--", name]);
    await git(workshop, ["commit", "-m", name]);
    return git(workshop, ["rev-parse", "HEAD"]);
  };
  await commit("first");
  await git(workshop, ["remote", "add", "origin", remote]);
  await git(workshop, ["push", "--set-upstream", "origin", "main:published"]);
  return { root, remote, workshop, commit };
}
it("pushes all unpushed commits to the configured upstream branch", async () => {
  const f = await fixture();
  await f.commit("old-change");
  const head = await f.commit("new-change");
  expect(await readWorkshopSync(f.workshop)).toMatchObject({ status: "ahead", ahead: 2, behind: 0 });
  expect(await pushWorkshop(f.workshop)).toMatchObject({ status: "pushed", commit: head });
  expect(await git(f.remote, ["rev-parse", "refs/heads/published"])).toBe(head);
  expect(await readWorkshopSync(f.workshop)).toMatchObject({ status: "current", ahead: 0, behind: 0 });
});
it("keeps a failed push recoverable without changing local committed bytes", async () => {
  const f = await fixture();
  const head = await f.commit("pending");
  await git(f.workshop, ["remote", "set-url", "origin", join(f.root, "missing.git")]);
  expect(await pushWorkshop(f.workshop)).toMatchObject({ status: "failed" });
  expect(await git(f.workshop, ["rev-parse", "HEAD"])).toBe(head);
  expect(await readWorkshopSync(f.workshop)).toMatchObject({ status: "unavailable" });
});
it("pushes only the approved branch even when Git is configured to follow tags", async () => {
  const f = await fixture();
  const head = await f.commit("pending");
  await git(f.workshop, ["tag", "-a", "unapproved-release", "-m", "Local release"]);
  await git(f.workshop, ["config", "push.followTags", "true"]);
  expect(await pushWorkshop(f.workshop)).toMatchObject({ status: "pushed", commit: head });
  expect(await git(f.remote, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/published");
});
it("refuses diverged history and preserves both branches", async () => {
  const f = await fixture();
  await git(f.root, ["clone", "--branch", "published", f.remote, join(f.root, "peer")]);
  const peer = join(f.root, "peer");
  await writeFile(join(peer, "peer"), "peer");
  await git(peer, ["add", "peer"]);
  await git(peer, ["-c", "user.name=Example", "-c", "user.email=ada@example.com", "commit", "-m", "peer"]);
  await git(peer, ["push", "origin", "published"]);
  const remoteHead = await git(peer, ["rev-parse", "HEAD"]);
  const head = await f.commit("local");
  const result = await pushWorkshop(f.workshop);
  expect(result.status).toBe("failed");
  expect(result.diagnostic).toMatch(/diverg|unavailable|fetch/i);
  expect(await git(f.remote, ["rev-parse", "published"])).toBe(remoteHead);
  expect(await git(f.workshop, ["rev-parse", "HEAD"])).toBe(head);
});
