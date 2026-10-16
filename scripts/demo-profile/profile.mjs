import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { homeFiles, marketplaceFiles, projectFiles } from "./fixtures.mjs";

const execute = promisify(execFile);

async function assertDestination(root) {
  const parts = [];
  for (let current = root; current !== parse(current).root; current = dirname(current)) parts.push(current);
  for (const part of parts.reverse()) {
    const info = await lstat(part).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Demo destination has a symbolic link: ${part}. Use a physical path.`);
    if (info && !info.isDirectory()) throw new Error(`Demo destination is not a directory: ${part}.`);
  }
  const entries = await readdir(root).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length) throw new Error(`Demo destination must be empty: ${root}. Choose a new directory.`);
}

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { flag: "wx" });
  }
}

async function initializeRepository(root, home) {
  // Do not inherit the caller's Git redirects, hooks, signing, templates or identity.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Ada Example",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada Example",
    GIT_COMMITTER_EMAIL: "ada@example.com",
    GIT_AUTHOR_DATE: "2026-10-16T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-16T00:00:00Z",
  });
  const git = (...args) => execute("git", ["-C", root, ...args], { env });
  await git("init", "--initial-branch=main", "--template=");
  await git("config", "core.hooksPath", "/dev/null");
  await git("add", "--all");
  await git("commit", "--no-gpg-sign", "-m", "Initialize synthetic demo");
}

/**
 * Create fixture files only. Omni owns registrations and receipts.
 * @returns {Promise<{root: string, home: string, userData: string, marketplace: string}>}
 */
export async function createDemoProfile(destination) {
  if (typeof destination !== "string" || !destination.trim()) throw new Error("Provide an empty demo directory.");
  const root = resolve(destination);
  await assertDestination(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  await writeFiles(home, homeFiles());
  for (const folder of ["userData", "tmp", "home/.claude/skills", "home/.codex/skills"])
    await mkdir(join(root, folder), { recursive: true });
  for (const name of ["acme-web", "notes-app", "acme-workspace"]) {
    const project = join(root, "projects", name);
    await writeFiles(project, projectFiles(name));
    await initializeRepository(project, home);
  }
  const marketplace = join(root, "acme-skills");
  await writeFiles(marketplace, marketplaceFiles());
  await initializeRepository(marketplace, home);
  return { root: await realpath(root), home, userData: join(root, "userData"), marketplace };
}
