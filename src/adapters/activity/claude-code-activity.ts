// Reads the "activity" signals (what the agent is doing right now) out of a Claude Code
// transcript tail: the session title, the latest prompt, the last tool used, a turn count, the
// last answer time, and a sub-agent count. Kept separate from `claude-code.ts` (which owns the
// session file and the transcript head) to keep both files under the line budget.
import type { AgentSession } from "../../shared/activity-ipc";
import { parseJsonLines, record, safeText, safeTimestamp, textSnippet, toolTarget, type RecordValue } from "./evidence";

export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

type SessionActivity = NonNullable<AgentSession["activity"]>;

export type ClaudeTailEvidence = Readonly<{
  title?: string;
  activity: SessionActivity;
}>;

// The bounded read returns exactly `TRANSCRIPT_TAIL_BYTES` bytes when the file is larger than
// the window (there is earlier content this pass never saw); a smaller read means the whole
// file fit. Approximate but conservative: `turns` is then reported as "at least".
function isTailTruncated(tailText: string): boolean {
  return Buffer.byteLength(tailText, "utf8") >= TRANSCRIPT_TAIL_BYTES;
}

function isMetaUser(item: RecordValue): boolean {
  return item.type === "user" && item.isMeta === true;
}

// Only a plain string `message.content` is something the user typed; an array of `tool_result`
// blocks is the harness reporting a tool's output back, not a prompt.
function userMessageText(item: RecordValue): string | undefined {
  if (item.type !== "user" || isMetaUser(item)) return undefined;
  const message = record(item.message);
  return typeof message?.content === "string" ? textSnippet(message.content, 600) : undefined;
}

function toolUseBlocks(item: RecordValue): RecordValue[] {
  if (item.type !== "assistant") return [];
  const content = record(item.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const entry = record(block);
    return entry && entry.type === "tool_use" ? [entry] : [];
  });
}

type Timestamped = Readonly<{ text: string; at?: number }>;

export function claudeTailEvidence(tailText: string): ClaudeTailEvidence {
  const lines = parseJsonLines(tailText);
  let title: string | undefined;
  let latestFromEvent: Timestamped | undefined;
  let latestFromUser: Timestamped | undefined;
  let lastTool: SessionActivity["lastTool"];
  let turns = 0;
  let lastAnswerAt: number | undefined;
  let subagents = 0;

  for (const item of lines) {
    if (item.type === "custom-title") {
      title = safeText(item.customTitle) ?? title;
      continue;
    }
    if (item.type === "last-prompt") {
      const value = textSnippet(item.lastPrompt, 600);
      if (value) latestFromEvent = { text: value, at: safeTimestamp(item.timestamp) };
      continue;
    }
    const userText = userMessageText(item);
    if (userText !== undefined) latestFromUser = { text: userText, at: safeTimestamp(item.timestamp) };
    if (item.type !== "assistant") continue;
    turns += 1;
    lastAnswerAt = safeTimestamp(item.timestamp) ?? lastAnswerAt;
    for (const block of toolUseBlocks(item)) {
      const name = safeText(block.name);
      if (!name) continue;
      const target = toolTarget(record(block.input));
      lastTool = { name, ...(target ? { target } : {}) };
      if (name === "Agent" || name === "Task") subagents += 1;
    }
  }

  // The last `last-prompt` event, when one exists in this window, is authoritative over any
  // plain user line — it is the harness's own record of what was most recently typed.
  const latest = latestFromEvent ?? latestFromUser;
  return {
    ...(title ? { title } : {}),
    activity: {
      ...(latest ? { latestPrompt: latest.text } : {}),
      ...(latest?.at !== undefined ? { latestPromptAt: latest.at } : {}),
      ...(lastTool ? { lastTool } : {}),
      turns,
      tailTruncated: isTailTruncated(tailText),
      ...(lastAnswerAt !== undefined ? { lastAnswerAt } : {}),
      subagents,
    },
  };
}
