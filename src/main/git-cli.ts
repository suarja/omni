import { push, remoteUrl, type GitPushResult, type GitPushTarget } from "./git-push";
export { push, remoteUrl } from "./git-push";
export type { GitPushResult, GitPushTarget } from "./git-push";
import { execFile as nodeExecFile } from "../adapters/owned-child-processes";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { safeGitArgs } from "./safe-git-args";

const execFile = promisify(nodeExecFile);

export type EnclosingRepositoryResult =
  | Readonly<{ status: "repository"; root: string }>
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "unavailable"; diagnostic: string }>;
export type GitCommitResult =
  Readonly<{ status: "committed"; commit: string }> | Readonly<{ status: "failed"; diagnostic: string }>;

export type GitCli = Readonly<{
  remoteUrl(root: string): Promise<string | undefined>;
  push(root: string, remote: string, branch: string, reviewed?: GitPushTarget): Promise<GitPushResult>;
  isGitAvailable(): Promise<boolean>;
  enclosingRepository(path: string): Promise<EnclosingRepositoryResult>;
  initAndCommit(target: string, message: string): Promise<GitCommitResult>;
  commitAll(root: string, message: string, paths: readonly string[]): Promise<GitCommitResult>;
  hasChanges(root: string, paths: readonly string[]): Promise<boolean>;
  isRepositoryRoot(root: string): Promise<boolean>;
  headCommit(root: string): Promise<string | undefined>;
}>;

function safeDiagnostic(): string {
  return "Git operation failed safely.";
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFile("git", safeGitArgs(args), {
    cwd,
    shell: false,
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    await runGit(["--version"], process.cwd());
    return true;
  } catch {
    return false;
  }
}

export async function enclosingRepository(path: string): Promise<EnclosingRepositoryResult> {
  if (!(await isGitAvailable())) return { status: "unavailable", diagnostic: "Git is unavailable." };
  try {
    const root = await runGit(["rev-parse", "--show-toplevel"], path);
    return root ? { status: "repository", root } : { status: "none" };
  } catch {
    return { status: "none" };
  }
}

export async function initAndCommit(target: string, message: string): Promise<GitCommitResult> {
  try {
    await runGit(["init", "-q"], target);
    await runGit(["add", "-A"], target);
    await runGit(["-c", "user.name=Omni", "-c", "user.email=omni@local", "commit", "-q", "-m", message], target);
    const commit = await runGit(["rev-parse", "HEAD"], target);
    if (!/^[0-9a-f]{7,64}$/.test(commit)) return { status: "failed", diagnostic: safeDiagnostic() };
    return { status: "committed", commit };
  } catch {
    return { status: "failed", diagnostic: safeDiagnostic() };
  }
}

export async function commitAll(root: string, message: string, paths: readonly string[]): Promise<GitCommitResult> {
  try {
    await runGit(["add", "--", ...paths], root);
    // Pathspec commit: only these paths are committed, whatever else the user has staged.
    await runGit(
      ["-c", "user.name=Omni", "-c", "user.email=omni@local", "commit", "-q", "-m", message, "--", ...paths],
      root,
    );
    const commit = await runGit(["rev-parse", "HEAD"], root);
    if (!/^[0-9a-f]{7,64}$/.test(commit)) return { status: "failed", diagnostic: safeDiagnostic() };
    return { status: "committed", commit };
  } catch {
    return { status: "failed", diagnostic: safeDiagnostic() };
  }
}

export async function hasChanges(root: string, paths: readonly string[]): Promise<boolean> {
  try {
    return (await runGit(["status", "--porcelain", "--", ...paths], root)).length > 0;
  } catch {
    return false;
  }
}

export async function isRepositoryRoot(root: string): Promise<boolean> {
  try {
    const detected = await runGit(["rev-parse", "--show-toplevel"], root);
    return detected === root || (await realpath(detected)) === (await realpath(root));
  } catch {
    return false;
  }
}

export async function headCommit(root: string): Promise<string | undefined> {
  try {
    const commit = await runGit(["rev-parse", "HEAD"], root);
    return /^[0-9a-f]{7,64}$/.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

export const systemGitCli: GitCli = {
  remoteUrl,
  push,
  isGitAvailable,
  enclosingRepository,
  initAndCommit,
  commitAll,
  isRepositoryRoot,
  headCommit,
  hasChanges,
};
