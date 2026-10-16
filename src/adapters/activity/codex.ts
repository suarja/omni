import { join } from "node:path";

import type { AgentSession, ActivityEntrypoint } from "../../shared/activity-ipc";
import type { ActivityEvidenceIo, ActivityHarnessAdapter, RootProcess } from ".";
import {
  displayPath,
  parseJsonLines,
  record,
  safeText,
  safeTimestamp,
  textSnippet,
  type RecordValue,
} from "./evidence";

type Rollout = Readonly<{
  cwd: string;
  timestamp: number;
  sessionId: string;
  path: string;
  task?: string;
}>;
type ChatProcess = Readonly<{
  osPid: number;
  cwd?: string;
  conversationId: string;
  chatTitle?: string;
}>;

const ROLLOUT_HEAD_BYTES = 128 * 1024;
// Best effort, matching the Claude Code tail window: read once a rollout is matched to a root,
// to pick up the activity signals (latest prompt, turn count) near the end of the file.
const ROLLOUT_TAIL_BYTES = 256 * 1024;
const MATCH_WINDOW_MS = 90 * 1000;
// Rollout file names carry the local start time (`rollout-2026-09-13T20-44-05-<id>.jsonl`);
// only files started near a running root are read, so a day with 150 rollouts costs a few reads.
const FILE_NAME_WINDOW_MS = 10 * 60 * 1000;

function commandTokens(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean);
}

const SUBCOMMANDS = new Set(["exec", "app-server", "sandbox", "resume", "review", "cloud", "login", "mcp"]);

// `codex -c key=value app-server …`: the subcommand is the first token that names one,
// so `-c` values are never mistaken for it.
function subcommand(command: string): string | undefined {
  return commandTokens(command)
    .slice(1)
    .find((token) => SUBCOMMANDS.has(token));
}

// `codex …`, `/…/Resources/codex …`, or `node /opt/homebrew/bin/codex …` (the npm CLI); never the
// desktop app binary nor `codex sandbox`.
function isRoot(command: string): boolean {
  if (/\/Codex\.app\/Contents\/MacOS\/Codex(?:\s|$)/u.test(command)) return false;
  const tokens = commandTokens(command);
  const position = tokens.findIndex((token) => /(?:^|\/)codex$/u.test(token));
  if (position < 0 || position > 1) return false;
  return subcommand(command) !== "sandbox";
}

function entrypointFor(command: string): ActivityEntrypoint {
  const commandName = subcommand(command);
  if (commandName === "app-server") return "app";
  if (commandName === "exec") return "exec";
  return "terminal";
}

function taskLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .split(/\r?\n/u)[0]
    ?.replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim();
  if (!text || text.startsWith("<")) return undefined;
  return text.slice(0, 120) || undefined;
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = record(value);
  if (object) return messageText(object.text ?? object.content ?? object.message);
  if (!Array.isArray(value)) return undefined;
  const first = record(value[0]);
  return typeof first?.text === "string" ? first.text : undefined;
}

function messageFromEvent(item: RecordValue): string | undefined {
  if (item.type === "event_msg") {
    const payload = record(item.payload);
    if (payload?.type === "user_message") {
      return taskLine(messageText(payload.message ?? payload.text ?? payload.content));
    }
  }
  const payload = record(item.payload);
  if (item.type === "response_item" && (item.role === "user" || payload?.role === "user")) {
    return taskLine(messageText(item.message ?? item.text ?? item.content ?? payload?.content));
  }
  return undefined;
}

function rolloutFromLines(lines: readonly RecordValue[], path: string): Rollout | undefined {
  const meta = lines.find((item) => item.type === "session_meta");
  const payload = meta ? record(meta.payload) : undefined;
  const cwd = safeText(payload?.cwd);
  const sessionId = safeText(payload?.session_id);
  const startedAt = safeTimestamp(payload?.timestamp);
  if (!cwd || !sessionId || sessionId.includes("/") || sessionId.includes("\\") || startedAt === undefined) {
    return undefined;
  }
  const task = lines.map(messageFromEvent).find((value): value is string => value !== undefined);
  return { cwd, sessionId, timestamp: startedAt, path, ...(task ? { task } : {}) };
}

// Best effort: only the user-message and role="assistant" shapes already trusted for `task`
// (above) are read here; anything else Codex rollouts may carry (tool calls, reasoning, …) has
// no evidence in this codebase and is left undefined rather than guessed at.
function latestUserMessage(item: RecordValue): Readonly<{ text: string; at?: number }> | undefined {
  const payload = record(item.payload);
  if (item.type === "event_msg" && payload?.type === "user_message") {
    const text = textSnippet(messageText(payload.message ?? payload.text ?? payload.content), 600);
    return text ? { text, at: safeTimestamp(item.timestamp ?? payload.timestamp) } : undefined;
  }
  if (item.type === "response_item" && (item.role === "user" || payload?.role === "user")) {
    const text = textSnippet(messageText(item.message ?? item.text ?? item.content ?? payload?.content), 600);
    return text ? { text, at: safeTimestamp(item.timestamp ?? payload?.timestamp) } : undefined;
  }
  return undefined;
}

function isAssistantTurn(item: RecordValue): boolean {
  const payload = record(item.payload);
  return item.type === "response_item" && (item.role === "assistant" || payload?.role === "assistant");
}

async function readRolloutActivity(
  path: string,
  io: ActivityEvidenceIo,
): Promise<AgentSession["activity"] | undefined> {
  const text = await io.readText(path, { tail: ROLLOUT_TAIL_BYTES });
  if (!text) return undefined;
  let latest: Readonly<{ text: string; at?: number }> | undefined;
  let turns = 0;
  let lastAnswerAt: number | undefined;
  for (const item of parseJsonLines(text)) {
    latest = latestUserMessage(item) ?? latest;
    if (!isAssistantTurn(item)) continue;
    turns += 1;
    lastAnswerAt = safeTimestamp(item.timestamp ?? record(item.payload)?.timestamp) ?? lastAnswerAt;
  }
  if (!latest && turns === 0) return undefined;
  return {
    ...(latest ? { latestPrompt: latest.text } : {}),
    ...(latest?.at !== undefined ? { latestPromptAt: latest.at } : {}),
    ...(turns > 0 ? { turns } : {}),
    ...(lastAnswerAt !== undefined ? { lastAnswerAt } : {}),
  };
}

function sessionBase(
  root: RootProcess,
  io: ActivityEvidenceIo,
  id: string,
  name: string,
  link: "session-file" | "rollout-match" | "process-only",
): AgentSession {
  return {
    id,
    harness: "codex",
    pid: root.pid,
    entrypoint: entrypointFor(root.command),
    name,
    cwd: displayPath(root.cwd ?? io.homeDir, io.homeDir),
    startedAt: root.startedAt,
    link,
    processPids: [],
    worktreeIds: [],
    totals: { cpuPercent: 0, rssMb: 0 },
    flags: [],
  };
}

function dayPath(now: number, offset: number): string {
  const date = new Date(now - offset * 86_400_000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return join(String(year), month, day);
}

function fileNameTimestamp(entry: string): number | undefined {
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/u.exec(entry);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const local = new Date(year!, month! - 1, day!, hour, minute, second).getTime();
  return Number.isFinite(local) ? local : undefined;
}

function nearRoot(entry: string, roots: readonly RootProcess[]): boolean {
  const started = fileNameTimestamp(entry);
  if (started === undefined) return true;
  return roots.some((root) => Math.abs(root.startedAt - started) <= FILE_NAME_WINDOW_MS);
}

async function rolloutFiles(io: ActivityEvidenceIo, roots: readonly RootProcess[]): Promise<string[]> {
  const now = io.now();
  const directories = await Promise.all(
    [0, 1, 2].map((offset) => io.readDir(join(io.homeDir, ".codex", "sessions", dayPath(now, offset)))),
  );
  return directories.flatMap((entries, index) =>
    entries
      .filter((entry) => /^rollout-.*\.jsonl$/u.test(entry) && nearRoot(entry, roots))
      .map((entry) => join(io.homeDir, ".codex", "sessions", dayPath(now, index), entry)),
  );
}

async function readRollouts(io: ActivityEvidenceIo, roots: readonly RootProcess[]): Promise<Rollout[]> {
  const files = await rolloutFiles(io, roots);
  const results = await Promise.all(
    files.map(async (path) => {
      const text = await io.readText(path, { head: ROLLOUT_HEAD_BYTES });
      return text ? rolloutFromLines(parseJsonLines(text), path) : undefined;
    }),
  );
  return results.flatMap((result) => (result ? [result] : []));
}

function closestRollout(root: RootProcess, rollouts: readonly Rollout[]): Rollout | undefined {
  if (!root.cwd) return undefined;
  return rollouts
    .filter((rollout) => rollout.cwd === root.cwd)
    .map((rollout) => ({ rollout, distance: Math.abs(rollout.timestamp - root.startedAt) }))
    .filter((candidate) => candidate.distance <= MATCH_WINDOW_MS)
    .sort((left, right) => left.distance - right.distance)[0]?.rollout;
}

function parseChatProcesses(value: unknown): ChatProcess[] {
  const values = Array.isArray(value)
    ? value
    : record(value)?.processes && Array.isArray(record(value)?.processes)
      ? record(value)?.processes
      : record(value)
        ? Object.values(record(value) as RecordValue)
        : [];
  return (values as unknown[]).flatMap((entry) => {
    const item = record(entry);
    if (!item || typeof item.osPid !== "number" || typeof item.conversationId !== "string") return [];
    return [
      {
        osPid: item.osPid,
        conversationId: item.conversationId,
        ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
        ...(typeof item.chatTitle === "string" ? { chatTitle: item.chatTitle } : {}),
      },
    ];
  });
}

async function appSessions(roots: readonly RootProcess[], io: ActivityEvidenceIo): Promise<AgentSession[]> {
  const appRoots = roots.filter((root) => entrypointFor(root.command) === "app");
  if (!appRoots.length) return [];
  const contents = await io.readText(join(io.homeDir, ".codex", "process_manager", "chat_processes.json"), {
    head: 128 * 1024,
  });
  if (!contents) return [];
  let entries: ChatProcess[];
  try {
    entries = parseChatProcesses(JSON.parse(contents));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (io.isProcessAlive ? io.isProcessAlive(entry.osPid) : true))
    .filter((entry) => !entry.conversationId.includes("/") && !entry.conversationId.includes("\\"))
    .flatMap((entry) => {
      const host = appRoots[0];
      if (!host) return [];
      const session = sessionBase(
        host,
        io,
        `codex:conversation:${entry.conversationId}`,
        safeText(entry.chatTitle) ?? "Codex conversation",
        "session-file",
      );
      return [
        {
          ...session,
          ...(entry.cwd ? { cwd: displayPath(entry.cwd, io.homeDir) } : {}),
          processPids: [entry.osPid],
        },
      ];
    });
}

async function rootSessions(roots: readonly RootProcess[], io: ActivityEvidenceIo): Promise<AgentSession[]> {
  const cliRoots = roots.filter((root) => entrypointFor(root.command) !== "app");
  if (!cliRoots.length) return [];
  const rollouts = await readRollouts(io, cliRoots);
  return Promise.all(
    cliRoots.map(async (root) => {
      const name = entrypointFor(root.command) === "exec" ? "Codex exec" : "Codex";
      const match = closestRollout(root, rollouts);
      if (!match) return sessionBase(root, io, `codex:pid:${root.pid}`, name, "process-only");
      const activity = await readRolloutActivity(match.path, io);
      return {
        ...sessionBase(root, io, `codex:${match.sessionId}`, name, "rollout-match"),
        ...(match.task ? { task: match.task } : {}),
        cwd: displayPath(match.cwd, io.homeDir),
        startedAt: match.timestamp,
        ...(activity ? { activity } : {}),
      };
    }),
  );
}

export const codexAdapter: ActivityHarnessAdapter = {
  harness: "codex",
  isRoot,
  entrypoint: entrypointFor,
  readSessions: async (roots, io) => [...(await rootSessions(roots, io)), ...(await appSessions(roots, io))],
};
