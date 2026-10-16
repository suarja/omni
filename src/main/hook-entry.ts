// The guard's PreToolUse hook entry (Brief B1): both harnesses store it the same way — a JSON
// object with a `hooks.PreToolUse` array of `{ matcher, hooks: [{ type, command, timeout }] }`
// entries. For Claude Code that array lives inside the larger `~/.claude/settings.json`
// (alongside unrelated keys); for Codex it is the entire content of a dedicated
// `~/.codex/hooks.json`. One set of helpers below reads and edits that array for both, mirroring
// `mcp-entry.ts`'s `mcpEntryState`/entry-builder split so install planning and restore share the
// same "is it Omni's, is it current" and "set it to this value" logic instead of each harness
// growing its own copy.
import { isDeepStrictEqual } from "node:util";

import type { AgentHarness } from "../shared/agents-ipc";
import { writeJsonPreservingFormat, type McpEntryState } from "./mcp-entry";

export type GuardHookEntry = Readonly<{
  matcher: string;
  hooks: readonly Readonly<{ type: "command"; command: string; timeout: number }>[];
}>;

const MATCHERS: Readonly<Record<AgentHarness, string>> = {
  "claude-code": "Edit|Write|MultiEdit|NotebookEdit|Bash",
  codex: "apply_patch|Edit|Write|Bash",
};

export function guardHookEntry(harness: AgentHarness, guardScriptPath: string): GuardHookEntry {
  return {
    matcher: MATCHERS[harness],
    hooks: [{ type: "command", command: `node "${guardScriptPath}"`, timeout: 10 }],
  };
}

type JsonRecord = Record<string, unknown>;

function parseRoot(content: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Hook settings are not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Hook settings must be a JSON object.");
  return parsed as JsonRecord;
}

function preToolUseArray(root: JsonRecord): readonly unknown[] {
  const hooks = root.hooks;
  if (hooks === undefined) return [];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) throw new Error("hooks must be an object.");
  const preToolUse = (hooks as JsonRecord).PreToolUse;
  if (preToolUse === undefined) return [];
  if (!Array.isArray(preToolUse)) throw new Error("hooks.PreToolUse must be an array.");
  return preToolUse;
}

/** The `command` of the entry's own hook that names omni-guard.mjs, or undefined if it is not Omni's. */
function omniHookCommand(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const list = (item as JsonRecord).hooks;
  if (!Array.isArray(list)) return undefined;
  for (const hook of list) {
    if (typeof hook !== "object" || hook === null) continue;
    const command = (hook as JsonRecord).command;
    if (typeof command === "string" && command.includes("omni-guard.mjs")) return command;
  }
  return undefined;
}

/** Reads Omni's guard entry from provider settings content — undefined when there is none. */
export function readGuardEntry(content: string | undefined): GuardHookEntry | undefined {
  if (content === undefined) return undefined;
  const array = preToolUseArray(parseRoot(content));
  return array.find((item) => omniHookCommand(item) !== undefined) as GuardHookEntry | undefined;
}

export function guardEntryState(
  content: string | undefined,
  harness: AgentHarness,
  guardScriptPath: string,
): McpEntryState {
  if (content === undefined) return { registered: false, current: false };
  try {
    const array = preToolUseArray(parseRoot(content));
    const mine = array.filter((item) => omniHookCommand(item) !== undefined);
    if (mine.length === 0) return { registered: false, current: false };
    return {
      registered: true,
      current: mine.length === 1 && isDeepStrictEqual(mine[0], guardHookEntry(harness, guardScriptPath)),
    };
  } catch {
    return { registered: false, current: false };
  }
}

/**
 * Sets Omni's guard entry to `value` (or removes it when `value` is undefined), preserving
 * every other key, other PreToolUse entries, and other hook events untouched. Replaces the
 * existing Omni entry in place when there is one, so an "update" produces a minimal diff;
 * otherwise appends (or, for a removal that empties the array, drops `PreToolUse` — and `hooks`
 * itself if it then holds nothing else). Returns undefined only when there is nothing to do
 * (no content and no value). The one function both install planning and restore call: neither
 * grows its own copy of this edit.
 */
export function setGuardEntry(content: string | undefined, value: GuardHookEntry | undefined): string | undefined {
  if (content === undefined) {
    if (value === undefined) return undefined;
    return writeJsonPreservingFormat(undefined, { hooks: { PreToolUse: [value] } });
  }
  const root = parseRoot(content);
  const next = JSON.parse(JSON.stringify(root)) as JsonRecord;
  const hooksContainer = (typeof next.hooks === "object" && next.hooks !== null ? next.hooks : {}) as JsonRecord;
  const array = Array.isArray(hooksContainer.PreToolUse) ? [...(hooksContainer.PreToolUse as unknown[])] : [];
  const index = array.findIndex((item) => omniHookCommand(item) !== undefined);
  const withoutMine = array.filter((item) => omniHookCommand(item) === undefined);
  const nextArray =
    value === undefined
      ? withoutMine
      : index === -1
        ? [...withoutMine, value]
        : [...withoutMine.slice(0, index), value, ...withoutMine.slice(index)];
  if (nextArray.length > 0) {
    hooksContainer.PreToolUse = nextArray;
    next.hooks = hooksContainer;
  } else {
    delete hooksContainer.PreToolUse;
    if (Object.keys(hooksContainer).length > 0) next.hooks = hooksContainer;
    else delete next.hooks;
  }
  return writeJsonPreservingFormat(content, next);
}
