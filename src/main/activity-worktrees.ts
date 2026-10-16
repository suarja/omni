import { execFile as nodeExecFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { ActivityEvidenceIo } from "../adapters/activity";
import type { Worktree } from "../shared/activity-ipc";
import { isWithin, type ActivityProjectRoot } from "./activity-paths";
import { createActivityEvidenceIo } from "./activity-evidence-io";
import { isOptionalDirectoryError } from "./isolated-directory-reader";
import { safeGitArgs } from "./safe-git-args";

const execFile = promisify(nodeExecFile);

export type RegisteredProjectRoot = ActivityProjectRoot;
export type ClaudeWorktreeSession = Readonly<{
  sessionId: string;
  cwd: string;
  transcriptDirectory: string;
}>;
type GitWorktree = Readonly<{ path: string; head?: string; branch?: string; isMain: boolean }>;
type ScanOptions = Readonly<{
  now?: number;
  timeoutMs?: number;
  claudeSessions?: readonly ClaudeWorktreeSession[];
  evidenceIo?: ActivityEvidenceIo;
}>;

function daysSince(timestampMs: number, now: number): number {
  return Math.max(0, Math.floor((now - timestampMs) / 86_400_000));
}

async function runGit(args: readonly string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execFile("git", safeGitArgs(args), {
    cwd,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return result.stdout.trim();
}

function parseWorktreePorcelain(output: string): GitWorktree[] {
  const records = output.split(/\n\n/u).map((record) => record.split(/\r?\n/u));
  return records.flatMap((lines, index) => {
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    if (!path) return [];
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5);
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice(7);
    return [
      {
        path,
        ...(head ? { head } : {}),
        ...(branchRef ? { branch: branchRef.replace(/^refs\/heads\//u, "") } : {}),
        isMain: index === 0,
      },
    ];
  });
}

async function worktreeState(
  path: string,
  now: number,
  timeoutMs: number,
): Promise<Pick<Worktree, "dirty" | "ageDays" | "lastActivityDays">> {
  try {
    const details = await stat(path);
    const [status, log] = await Promise.all([
      runGit(["status", "--porcelain"], path, timeoutMs),
      runGit(["log", "-1", "--format=%ct"], path, timeoutMs),
    ]);
    const commitSeconds = Number(log);
    return {
      dirty: status.length > 0,
      ageDays: daysSince(details.birthtimeMs || details.mtimeMs, now),
      lastActivityDays:
        Number.isFinite(commitSeconds) && commitSeconds > 0
          ? daysSince(commitSeconds * 1000, now)
          : daysSince(details.mtimeMs, now),
    };
  } catch {
    return { dirty: "unknown", ageDays: 0, lastActivityDays: 0 };
  }
}

async function folderCandidates(root: string, evidenceIo: ActivityEvidenceIo): Promise<string[]> {
  const result: string[] = [];
  for (const name of [".worktrees", ".claude/worktrees", ".codex/worktrees"]) {
    try {
      const directory = resolve(root, name);
      for (const entry of await evidenceIo.readDir(directory)) {
        const path = resolve(directory, entry);
        if ((await lstat(path)).isDirectory()) result.push(path);
      }
    } catch (error: unknown) {
      if (!isOptionalDirectoryError(error)) throw error;
      // Optional agent directories are evidence, not errors.
    }
  }
  return result;
}

async function sessionForFolder(
  project: RegisteredProjectRoot,
  path: string,
  sessions: readonly ClaudeWorktreeSession[],
  io: ActivityEvidenceIo | undefined,
): Promise<string | undefined> {
  if (!basename(path).startsWith("agent-")) return undefined;
  if (!path.includes(`${sep}.claude${sep}worktrees${sep}`)) return undefined;
  for (const session of sessions) {
    if (!isWithin(project.root, session.cwd)) continue;
    const subagent = resolve(session.transcriptDirectory, session.sessionId, "subagents", basename(path) + ".jsonl");
    if (io) {
      if (await io.stat(subagent)) return `claude-code:${session.sessionId}`;
      continue;
    }
    try {
      await stat(subagent);
      return `claude-code:${session.sessionId}`;
    } catch {
      continue;
    }
  }
  return undefined;
}

function sortWorktrees(worktrees: readonly Worktree[]): Worktree[] {
  return [...worktrees].sort(
    (left, right) =>
      Number(right.isMain) - Number(left.isMain) ||
      right.lastActivityDays - left.lastActivityDays ||
      left.id.localeCompare(right.id),
  );
}

async function scanProject(
  project: RegisteredProjectRoot,
  now: number,
  timeoutMs: number,
  options: ScanOptions,
): Promise<Worktree[]> {
  const root = await realpath(project.root).catch(() => null);
  if (!root) return [];
  const projectName = project.projectName ?? basename(root);
  let gitWorktrees: GitWorktree[] = [];
  try {
    gitWorktrees = parseWorktreePorcelain(await runGit(["worktree", "list", "--porcelain"], root, timeoutMs));
  } catch {
    gitWorktrees = [];
  }
  const known = new Set<string>();
  const result: Worktree[] = [];
  for (const item of gitWorktrees) {
    const path = await realpath(item.path).catch(() => item.path);
    if (!isWithin(root, path)) continue;
    known.add(path);
    const state = await worktreeState(path, now, timeoutMs);
    result.push({
      projectId: project.projectId,
      projectName,
      id: item.isMain ? "main" : relative(root, path).replaceAll(sep, "/"),
      ...(item.branch ? { branch: item.branch } : {}),
      ...(item.head ? { head: item.head } : {}),
      kind: "git-worktree",
      ...state,
      isMain: item.isMain,
    });
  }
  for (const path of await folderCandidates(root, options.evidenceIo ?? createActivityEvidenceIo())) {
    const canonical = await realpath(path).catch(() => path);
    if (
      known.has(canonical) ||
      [...known].some((knownPath) => knownPath !== canonical && isWithin(canonical, knownPath)) ||
      !isWithin(root, canonical)
    )
      continue;
    const state = await worktreeState(canonical, now, timeoutMs);
    const sessionId = await sessionForFolder(project, canonical, options.claudeSessions ?? [], options.evidenceIo);
    result.push({
      projectId: project.projectId,
      projectName,
      id: relative(root, canonical).replaceAll(sep, "/"),
      kind: "folder",
      ...state,
      isMain: false,
      ...(sessionId ? { sessionId } : {}),
    });
  }
  return sortWorktrees(result);
}

export async function scanWorktrees(
  projects: readonly RegisteredProjectRoot[],
  options: ScanOptions = {},
): Promise<Worktree[]> {
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const evidenceIo = options.evidenceIo ?? createActivityEvidenceIo();
  const scanOptions = { ...options, evidenceIo };
  const results = await Promise.all(projects.map((project) => scanProject(project, now, timeoutMs, scanOptions)));
  return results.flat();
}

export function worktreePath(root: string, worktree: Worktree): string {
  return resolve(root, worktree.id === "main" ? "." : worktree.id);
}
