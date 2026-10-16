import { join } from "node:path";

import type { AgentSession, ActivityEntrypoint } from "../../shared/activity-ipc";
import type { ActivityEvidenceIo, ActivityHarnessAdapter, RootProcess } from ".";
import { claudeTailEvidence, TRANSCRIPT_TAIL_BYTES } from "./claude-code-activity";
import {
  displayPath,
  parseJsonLines,
  record,
  safeText,
  safeTimestamp,
  textSnippet,
  type RecordValue,
} from "./evidence";

type ClaudeSessionFile = Readonly<{
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number | string;
}>;

const SESSION_HEAD_BYTES = 32 * 1024;
const TRANSCRIPT_HEAD_BYTES = 128 * 1024;

// The CLI executable is `claude` (case-sensitive): the desktop app itself is `…/Claude.app/Contents/MacOS/Claude`
// and its helpers (`claude-ios-sim`, …) are not sessions.
function isRoot(command: string): boolean {
  // The executable path may contain spaces ("Application Support"), so match the basename in place.
  return /(?:^|\/)claude(?:\s|$)/u.test(command) && !/\.app\/Contents\/MacOS\/Claude(?:\s|$)/u.test(command);
}

function entrypointFor(command: string): ActivityEntrypoint {
  const desktopPath = /Application Support\/[^/]*\/claude-code\//iu.test(command);
  return desktopPath || /--output-format\s+stream-json(?:\s|$)/u.test(command) ? "desktop" : "terminal";
}

function firstPromptLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .split(/\r?\n/u)[0]
    ?.replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim();
  if (!text || text.startsWith("<") || text.startsWith("/")) return undefined;
  return text.slice(0, 120) || undefined;
}

function promptText(content: string): string | undefined {
  // A slash command arrives wrapped (`<command-message>…</command-message><command-name>/x</command-name>`):
  // the command name is the task.
  const command = /<command-name>\s*([^<\s]+)\s*<\/command-name>/u.exec(content)?.[1];
  return command ? safeText(command)?.slice(0, 120) : firstPromptLine(content);
}

function userPrompt(item: RecordValue): string | undefined {
  // `isMeta` marks injected content (skill bodies, system context), not something the user typed.
  if (item.type !== "user" || item.isMeta === true) return undefined;
  const message = record(item.message);
  const content = message?.content;
  if (typeof content === "string") return promptText(content);
  if (!Array.isArray(content)) return undefined;
  const first = record(content[0]);
  return first?.type === "text" ? firstPromptLine(first.text) : undefined;
}

// The same eligible prompt as `userPrompt`, but kept in full (up to 600 characters, newlines
// collapsed) instead of trimmed to its first line — feeds `activity.firstPrompt`, which the
// owner wants to read in full rather than as a truncated task label.
function firstPromptFull(item: RecordValue): string | undefined {
  if (item.type !== "user" || item.isMeta === true) return undefined;
  const message = record(item.message);
  const content = message?.content;
  if (typeof content === "string") {
    const command = /<command-name>\s*([^<\s]+)\s*<\/command-name>/u.exec(content)?.[1];
    if (command) return safeText(command)?.slice(0, 120);
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith("<")) return undefined;
    return textSnippet(content, 600);
  }
  if (!Array.isArray(content)) return undefined;
  const first = record(content[0]);
  return first?.type === "text" ? textSnippet(first.text, 600) : undefined;
}

// Observed on macOS: "/" and whitespace become "-", dots are kept
// (`/Users/example/Downloads/Sample Files` → `-Users-example-Downloads-Sample-Files`, `.worktrees` stays `.worktrees`).
function slugFor(cwd: string): string {
  return cwd.replace(/[/\s]/gu, "-");
}

function sessionBase(root: RootProcess, io: ActivityEvidenceIo, sessionId: string): AgentSession {
  return {
    id: `claude-code:${sessionId}`,
    harness: "claude-code",
    pid: root.pid,
    entrypoint: entrypointFor(root.command),
    name: "Claude Code",
    cwd: displayPath(root.cwd ?? io.homeDir, io.homeDir),
    startedAt: root.startedAt,
    link: "process-only",
    processPids: [],
    worktreeIds: [],
    totals: { cpuPercent: 0, rssMb: 0 },
    flags: [],
  };
}

function sessionFile(value: unknown): ClaudeSessionFile | undefined {
  const item = record(value);
  if (!item || typeof item.pid !== "number" || typeof item.sessionId !== "string") return undefined;
  if (!item.sessionId || item.sessionId.includes("/") || item.sessionId.includes("\\")) return undefined;
  return {
    pid: item.pid,
    sessionId: item.sessionId,
    ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
    ...(typeof item.startedAt === "number" || typeof item.startedAt === "string" ? { startedAt: item.startedAt } : {}),
  };
}

function transcriptDetails(lines: readonly RecordValue[]): {
  name?: string;
  cwd?: string;
  branch?: string;
  lastActivityAt?: number;
} {
  for (const item of [...lines].reverse()) {
    const slug = safeText(item.slug);
    const cwd = safeText(item.cwd);
    const branch = safeText(item.gitBranch);
    const lastActivityAt = safeTimestamp(item.timestamp);
    if (slug || cwd || branch || lastActivityAt !== undefined) {
      return {
        ...(slug ? { name: slug } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {}),
        ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      };
    }
  }
  return {};
}

async function readSession(root: RootProcess, io: ActivityEvidenceIo): Promise<AgentSession> {
  const fallbackId = `pid:${root.pid}`;
  const fallback = sessionBase(root, io, fallbackId);
  const path = join(io.homeDir, ".claude", "sessions", `${root.pid}.json`);
  const contents = await io.readText(path, { head: SESSION_HEAD_BYTES });
  if (!contents) return fallback;
  let parsed: ClaudeSessionFile | undefined;
  try {
    parsed = sessionFile(JSON.parse(contents));
  } catch {
    return fallback;
  }
  if (!parsed || parsed.pid !== root.pid) return fallback;
  const session = sessionBase(root, io, parsed.sessionId);
  const cwd = parsed.cwd ?? root.cwd;
  const transcriptPath = cwd ? claudeTranscriptPath(io.homeDir, cwd, parsed.sessionId) : undefined;
  const [tail, head] = transcriptPath
    ? await Promise.all([
        io.readText(transcriptPath, { tail: TRANSCRIPT_TAIL_BYTES }),
        io.readText(transcriptPath, { head: TRANSCRIPT_HEAD_BYTES }),
      ])
    : [null, null];
  const tailDetails = transcriptDetails(tail ? parseJsonLines(tail) : []);
  const tailEvidence = tail ? claudeTailEvidence(tail) : undefined;
  const headLines = head ? parseJsonLines(head) : [];
  const task = headLines.map(userPrompt).find((prompt): prompt is string => prompt !== undefined);
  const firstPrompt = headLines.map(firstPromptFull).find((prompt): prompt is string => prompt !== undefined);
  const currentCwd = tailDetails.cwd ?? cwd ?? io.homeDir;
  const activity =
    firstPrompt || tailEvidence
      ? { ...(firstPrompt ? { firstPrompt } : {}), ...(tailEvidence?.activity ?? {}) }
      : undefined;
  return {
    ...session,
    ...(tailDetails.name ? { name: tailDetails.name } : {}),
    ...(task ? { task } : {}),
    cwd: displayPath(currentCwd, io.homeDir),
    ...(tailDetails.branch ? { branch: tailDetails.branch } : {}),
    startedAt: safeTimestamp(parsed.startedAt) ?? root.startedAt,
    ...(tailDetails.lastActivityAt !== undefined ? { lastActivityAt: tailDetails.lastActivityAt } : {}),
    link: "session-file",
    ...(tailEvidence?.title ? { title: tailEvidence.title } : {}),
    ...(activity ? { activity } : {}),
  };
}

export function claudeTranscriptDirectory(homeDir: string, cwd: string): string {
  return join(homeDir, ".claude", "projects", slugFor(cwd));
}

export function claudeTranscriptPath(homeDir: string, cwd: string, sessionId: string): string {
  return join(claudeTranscriptDirectory(homeDir, cwd), `${sessionId}.jsonl`);
}

export const claudeCodeAdapter: ActivityHarnessAdapter = {
  harness: "claude-code",
  isRoot,
  entrypoint: entrypointFor,
  readSessions: (roots, io) => Promise.all(roots.map((root) => readSession(root, io))),
};
