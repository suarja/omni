import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cloneExternalReadCopy,
  refreshExternalReadCopy,
  redactGitDiagnostic,
  classifyGitFailure,
} from "../../src/main/git-command";
import { git, write, commit } from "../helpers/publication-fixture";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("external read copies", () => {
  it("clones then follows changes of the remote default branch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omni-e1-git-")));
    roots.push(root);
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const copy = join(root, "copy");
    await mkdir(source);
    await git(root, "init", "--bare", remote);
    await git(source, "init", "-b", "main");
    await write(source, "skills/a/SKILL.md", "base");
    await commit(source);
    await git(source, "push", remote, "main");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    await cloneExternalReadCopy(root, remote, copy);
    expect(await readFile(join(copy, "skills/a/SKILL.md"), "utf8")).toBe("base");
    await git(source, "checkout", "-b", "next");
    await write(source, "skills/a/SKILL.md", "next");
    await commit(source);
    await git(source, "push", remote, "next");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/next");
    await refreshExternalReadCopy(copy, remote);
    expect(await readFile(join(copy, "skills/a/SKILL.md"), "utf8")).toBe("next");
    await expect(refreshExternalReadCopy(copy, join(root, "missing.git"))).rejects.toThrow();
    expect(await readFile(join(copy, "skills/a/SKILL.md"), "utf8")).toBe("next");
  }, 60000);
  it("rejects symlink read copies and redacts credentials and private paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-e1-git-link-"));
    roots.push(root);
    const link = join(root, "link");
    await symlink(root, link);
    await expect(refreshExternalReadCopy(link, "https://github.com/a/b.git")).rejects.toThrow();
    const error = {
      stderr: "Authentication failed https://user:secret@github.com/a/b /Users/example/private token=abc",
    };
    const message = redactGitDiagnostic(error);
    expect(message).not.toMatch(/secret|\/Users\/example|abc/u);
    expect(classifyGitFailure(error).type).toBe("auth");
    expect(classifyGitFailure({ stderr: "Could not resolve host: github.com" }).type).toBe("offline");
    expect(classifyGitFailure({ stderr: "Repository not found" }).type).toBe("not-found");
    expect(classifyGitFailure({ killed: true }).type).toBe("timeout");
  });
});
