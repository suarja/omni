import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRegistrationPath } from "../../src/main/project-registration-path";

const roots: string[] = [];
const policy = { homeDir: "/fixture-home", systemRoots: ["/System", "/usr"], temporaryRoots: [] };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-f3-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project registration path", () => {
  it("resolves a Git subfolder to the top-level without writing project files", async () => {
    const root = await fixture();
    await promisify(execFile)("git", ["init", "-q", root]);
    await mkdir(join(root, "docs"));
    expect(await resolveRegistrationPath(join(root, "docs"), undefined, [], policy)).toMatchObject({
      status: "resolved",
      root,
      gitRoot: true,
    });
  });
  it("uses a plain folder without Git", async () => {
    const root = await fixture();
    expect(await resolveRegistrationPath(root, root, [], policy)).toMatchObject({
      status: "resolved",
      root,
      gitRoot: false,
    });
  });
  it("uses a plain folder without Git under a French process locale", async () => {
    const root = await fixture();
    const previousLang = process.env.LANG;
    const previousLcAll = process.env.LC_ALL;
    process.env.LANG = "fr_FR.UTF-8";
    process.env.LC_ALL = "fr_FR.UTF-8";
    try {
      expect(await resolveRegistrationPath(root, root, [], policy)).toMatchObject({
        status: "resolved",
        root,
        gitRoot: false,
      });
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
      if (previousLcAll === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLcAll;
    }
  });
  it.each([false, true])("resolves an explicit sibling folder with Git=%s", async (repository) => {
    const root = await fixture();
    const cwd = join(root, "caller");
    const target = join(root, "target");
    await mkdir(cwd);
    await mkdir(join(target, "docs"), { recursive: true });
    if (repository) await promisify(execFile)("git", ["init", "-q", target]);
    const path = repository ? join(target, "docs") : target;
    for (const explicit of [path, repository ? "../target/docs" : "../target"])
      expect(await resolveRegistrationPath(cwd, explicit, [], policy)).toMatchObject({
        status: "resolved",
        root: target,
        cwd,
        gitRoot: repository,
      });
  });
  it("accepts an absolute target without caller cwd", async () => {
    const root = await fixture();
    expect(await resolveRegistrationPath(undefined, root, [], policy)).toMatchObject({ status: "resolved", root });
  });
  it("checks the explicit target independently of an unavailable or protected caller folder", async () => {
    const root = await fixture();
    for (const cwd of ["/", "/missing-session-folder"])
      expect(await resolveRegistrationPath(cwd, root, [], policy)).toMatchObject({ status: "resolved", root });
  });
  it.each(["/", "/Users", "/private", "/System", "/usr", "/tmp"])(
    "refuses protected folder %s before trying to read it",
    async (path) => {
      for (const args of [
        [path, undefined],
        ["/safe-caller", path],
      ] as const)
        expect(await resolveRegistrationPath(args[0], args[1], [])).toMatchObject({
          status: "blocked",
          code: "project-path-protected",
        });
    },
  );
  it("refuses the home folder itself", async () => {
    const root = await fixture();
    for (const args of [
      [root, undefined],
      ["/safe-caller", root],
    ] as const)
      expect(await resolveRegistrationPath(args[0], args[1], [], { ...policy, homeDir: root })).toMatchObject({
        status: "blocked",
        code: "project-path-protected",
      });
  });
  it("refuses temporary system subfolders", async () => {
    const root = await fixture();
    for (const args of [
      [root, undefined],
      ["/safe-caller", root],
    ] as const)
      expect(await resolveRegistrationPath(args[0], args[1], [])).toMatchObject({
        status: "blocked",
        code: "project-path-protected",
      });
  });
  it("refuses an explicit Git subfolder whose root is protected", async () => {
    const root = await fixture();
    await promisify(execFile)("git", ["init", "-q", root]);
    await mkdir(join(root, "docs"));
    expect(
      await resolveRegistrationPath(await fixture(), join(root, "docs"), [], { ...policy, homeDir: root }),
    ).toMatchObject({ status: "blocked", code: "project-path-protected" });
  });
  it("refuses marketplace roots, children and containing folders", async () => {
    const root = await fixture();
    const source = join(root, "marketplace");
    const child = join(source, "skills");
    await mkdir(child, { recursive: true });
    for (const path of [root, source, child])
      for (const args of [
        [path, undefined],
        [await fixture(), path],
      ] as const)
        expect(await resolveRegistrationPath(args[0], args[1], [source], policy)).toMatchObject({
          status: "blocked",
          code: "project-marketplace-overlap",
        });
  });
  it("refuses missing folders", async () => {
    const root = await fixture();
    for (const args of [
      [join(root, "missing"), undefined],
      [root, join(root, "missing")],
    ] as const)
      expect(await resolveRegistrationPath(args[0], args[1], [], policy)).toMatchObject({
        status: "blocked",
        code: "project-folder-unavailable",
      });
    await access(root);
  });
  it("refuses a symlink escaping to another folder", async () => {
    const root = await fixture();
    await mkdir(join(root, "actual"));
    await symlink(join(root, "actual"), join(root, "alias"));
    for (const args of [
      [join(root, "alias"), undefined],
      [root, join(root, "alias")],
    ] as const)
      expect(await resolveRegistrationPath(args[0], args[1], [], policy)).toMatchObject({
        status: "blocked",
        code: "project-symlink-escape",
      });
  });
  it("refuses an unreadable folder", async () => {
    const root = await fixture();
    await chmod(root, 0o000);
    try {
      for (const args of [
        [root, undefined],
        [await fixture(), root],
      ] as const)
        expect(await resolveRegistrationPath(args[0], args[1], [], policy)).toMatchObject({
          status: "blocked",
          code: "project-folder-unavailable",
        });
    } finally {
      await chmod(root, 0o700);
    }
  });
  it.each([undefined, "../target"])("refuses path %s without caller cwd", async (path) => {
    expect(await resolveRegistrationPath(undefined, path, [], policy)).toMatchObject({
      status: "blocked",
      code: "project-cwd-unavailable",
    });
  });
});
