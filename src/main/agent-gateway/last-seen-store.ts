import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentHarness } from "../../shared/agents-ipc";

export type AgentLastSeen = Readonly<Record<AgentHarness, string | undefined>>;
export type LastSeenStore = Readonly<{
  lastSeen(): Promise<AgentLastSeen>;
  record(harness: AgentHarness, at?: string): Promise<void>;
}>;

const HARNESSES = ["claude-code", "codex"] as const;

function empty(): AgentLastSeen {
  return { "claude-code": undefined, codex: undefined };
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && new Date(value).toISOString() === value;
}

function readState(value: unknown): AgentLastSeen {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return empty();
  const input = value as Record<string, unknown>;
  return {
    "claude-code": validIso(input["claude-code"]) ? input["claude-code"] : undefined,
    codex: validIso(input.codex) ? input.codex : undefined,
  };
}

export function createLastSeenStore(userDataPath: string, now: () => number = Date.now): LastSeenStore {
  const path = join(userDataPath, "omni", "agent-last-seen.json");
  let state: AgentLastSeen | undefined;
  let queue = Promise.resolve();
  const load = async (): Promise<AgentLastSeen> => {
    if (state) return state;
    try {
      state = readState(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch {
      state = empty();
    }
    return state;
  };
  const persist = async (next: AgentLastSeen): Promise<void> => {
    await mkdir(join(userDataPath, "omni"), { recursive: true, mode: 0o755 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };
  return {
    lastSeen: async () => load(),
    record: async (harness, at = new Date(now()).toISOString()) => {
      if (!HARNESSES.includes(harness) || !validIso(at)) throw new Error("Agent last-seen value is invalid.");
      const task = queue.then(async () => {
        const next = { ...(await load()), [harness]: at };
        await persist(next);
        state = next;
      });
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      await task;
    },
  };
}
