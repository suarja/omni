import { createElement, Fragment, type ReactNode } from "react";

import type { AgentProcess, AgentSession, ActivitySnapshot, ProcessFlag, Worktree } from "../../shared/activity-ipc";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import type { TranslationFunction } from "../i18n";
import { formatElapsed, formatSize, type ElapsedLanguage } from "./format";

export type ActivityEntry = Readonly<{
  hostProcess?: AgentProcess;
  session: AgentSession;
}>;

export function flagTone(flag: ProcessFlag): BadgeTone {
  if (flag === "runaway") return "bad";
  if (flag === "duplicate") return "warn";
  return "neutral";
}

export function flagBadges(flags: readonly ProcessFlag[], t: TranslationFunction): ReactNode {
  return [...new Set(flags)].map((flag) =>
    createElement(Badge, {
      children: t(`activity.flags.${flag}`),
      dotTone: flagTone(flag),
      key: flag,
      tone: flagTone(flag),
      variant: "status",
    }),
  );
}

export function processesForSession(snapshot: ActivitySnapshot, session: AgentSession): readonly AgentProcess[] {
  const pids = new Set(session.processPids);
  return snapshot.processes.filter((process) => pids.has(process.pid) || process.sessionId === session.id);
}

// A host (the Codex app, an unlinked root) owns every process under it that no session claims.
function hostSubtree(snapshot: ActivitySnapshot, root: AgentProcess): readonly AgentProcess[] {
  const byParent = new Map<number, AgentProcess[]>();
  for (const process of snapshot.processes) {
    if (process.sessionId) continue;
    byParent.set(process.ppid, [...(byParent.get(process.ppid) ?? []), process]);
  }
  const result: AgentProcess[] = [];
  const visit = (process: AgentProcess): void => {
    result.push(process);
    for (const child of byParent.get(process.pid) ?? []) visit(child);
  };
  visit(root);
  return result;
}

function hostSession(snapshot: ActivitySnapshot, root: AgentProcess): AgentSession {
  const subtree = hostSubtree(snapshot, root);
  const startedAt = Date.now() - root.elapsedSeconds * 1_000;
  return {
    id: `pid:${root.pid}`,
    harness: root.agent === "claude-code" ? "claude-code" : "codex",
    pid: root.pid,
    entrypoint: root.agent === "codex" ? "app" : "terminal",
    name: root.name,
    cwd: "",
    startedAt,
    link: "process-only",
    processPids: subtree.map((process) => process.pid),
    worktreeIds: [],
    totals: {
      cpuPercent: Math.round(subtree.reduce((sum, process) => sum + process.cpuPercent, 0) * 10) / 10,
      rssMb: Math.round(subtree.reduce((sum, process) => sum + process.rssMb, 0) * 10) / 10,
    },
    flags: [...new Set(subtree.flatMap((process) => process.flags))],
  };
}

export function activityEntries(snapshot: ActivitySnapshot): readonly ActivityEntry[] {
  const sessions = [...snapshot.sessions]
    .sort((left, right) => Number(left.link === "process-only") - Number(right.link === "process-only"))
    .map((session) => ({ session }));
  const hosts = snapshot.processes
    .filter((process) => process.depth === 0 && !process.sessionId)
    .map((process) => ({ hostProcess: process, session: hostSession(snapshot, process) }));
  return [...sessions, ...hosts];
}

export function entryProcesses(snapshot: ActivitySnapshot, entry: ActivityEntry): readonly AgentProcess[] {
  return processesForSession(snapshot, entry.session);
}

export function entryFlags(snapshot: ActivitySnapshot, entry: ActivityEntry): readonly ProcessFlag[] {
  return [...new Set([...entry.session.flags, ...entryProcesses(snapshot, entry).flatMap((process) => process.flags)])];
}

export function entrySearchText(snapshot: ActivitySnapshot, entry: ActivityEntry): string {
  const processText = entryProcesses(snapshot, entry)
    .flatMap((process) => [String(process.pid), process.command, process.name])
    .join(" ");
  return [
    entry.session.name,
    entry.session.task,
    entry.session.title,
    entry.session.projectName,
    entry.session.branch,
    entry.session.cwd,
    entry.session.activity?.firstPrompt,
    entry.session.activity?.latestPrompt,
    processText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Row name (D1 of the iteration-3 design): harness · project · branch, empty parts omitted —
// e.g. "Claude Code · acme-workspace · dev". Shared by the row and, through `title ?? name`, the
// session page head.
export function sessionRowName(session: AgentSession, t: TranslationFunction): string {
  if (session.harness === "omni") return session.name;
  return [t(`activity.harness.${session.harness}`), session.projectName, session.branch].filter(Boolean).join(" · ");
}

// Second line: the title when the owner set one, else the latest prompt (bounded to 160
// characters), else the legacy first-prompt task label.
export function sessionTaskSummary(session: AgentSession): string | undefined {
  if (session.title) return session.title;
  const latest = session.activity?.latestPrompt;
  return latest ? latest.slice(0, 160) : session.task;
}

// The row's sub line: the task summary, then the session slug as a muted, monospaced fragment
// — kept as plain inline spans (no flex wrapper) so the two-line clamp on `.ui-item__sub` still
// clips correctly.
export function sessionRowSub(session: AgentSession): ReactNode {
  const summary = sessionTaskSummary(session);
  return createElement(
    Fragment,
    null,
    summary ? `${summary} · ` : null,
    createElement("span", { style: { color: "var(--color-ink-faint)", fontFamily: "var(--font-mono)" } }, session.name),
  );
}

export function processSide(process: AgentProcess, language: ElapsedLanguage): string {
  const elapsed = formatElapsed(process.elapsedSeconds, language);
  return `${process.cpuPercent.toFixed(1)} % · ${formatSize(process.rssMb)} · ${elapsed}`;
}

export function worktreeForSessionId(worktrees: readonly Worktree[], sessionId: string): readonly Worktree[] {
  return worktrees.filter((worktree) => worktree.sessionId === sessionId);
}

export function worktreeForSessionRef(
  worktrees: readonly Worktree[],
  projectId: string,
  worktreeId: string,
): Worktree | undefined {
  return worktrees.find((worktree) => worktree.projectId === projectId && worktree.id === worktreeId);
}

export function worktreeIsStale(worktree: Worktree): boolean {
  return !worktree.isMain && worktree.lastActivityDays > 14 && worktree.dirty === false;
}
