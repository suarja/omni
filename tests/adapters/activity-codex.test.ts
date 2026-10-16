import { describe, expect, it } from "vitest";

import { codexAdapter } from "../../src/adapters/activity/codex";
import type { ActivityEvidenceIo, RootProcess } from "../../src/adapters/activity";

function dayPath(now: number, offset: number): string {
  const date = new Date(now - offset * 86_400_000);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function createIo(files: Record<string, string>, alive = new Set<number>(), extraEntries: string[] = []) {
  const now = Date.parse("2026-09-14T12:00:00.000Z");
  const calls: { path: string; options: { head?: number; tail?: number } }[] = [];
  const io: ActivityEvidenceIo = {
    homeDir: "/Users/example",
    now: () => now,
    readText: async (path, options) => {
      calls.push({ path, options });
      return files[path] ?? null;
    },
    readDir: async (path) =>
      path.endsWith(dayPath(now, 0)) ? ["rollout-a.jsonl", "rollout-b.jsonl", ...extraEntries] : [],
    stat: async () => null,
    isProcessAlive: (pid) => alive.has(pid),
  };
  return { io, calls, now };
}

describe("Codex activity adapter", () => {
  it("matches the closest rollout within 90 seconds and reads each file once", async () => {
    const cwd = "/Users/example/Projects/acme-workspace";
    const { io, calls, now } = createIo({
      "/Users/example/.codex/sessions/2026/09/14/rollout-a.jsonl": JSON.stringify({
        type: "session_meta",
        payload: { cwd, timestamp: "2026-09-14T11:59:10.000Z", session_id: "far" },
      }),
      "/Users/example/.codex/sessions/2026/09/14/rollout-b.jsonl":
        JSON.stringify({
          type: "session_meta",
          payload: { cwd, timestamp: "2026-09-14T11:59:50.000Z", session_id: "close" },
        }) +
        "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Mission: inspect" } }),
    });
    const root: RootProcess = { pid: 101, command: "codex exec --brief", cwd, startedAt: now - 20_000 };

    const [session] = await codexAdapter.readSessions([root], io);

    expect(session).toMatchObject({
      id: "codex:close",
      name: "Codex exec",
      task: "Mission: inspect",
      link: "rollout-match",
      cwd: "~/Projects/acme-workspace",
      activity: { latestPrompt: "Mission: inspect" },
    });
    // Two head reads to find the closest match, plus one tail read of the matched file for its
    // activity signals.
    expect(calls.filter((call) => call.path.includes("rollout-")).length).toBe(3);
    expect(
      calls.filter((call) => call.path.endsWith("rollout-b.jsonl") && call.options.tail !== undefined).length,
    ).toBe(1);
  });

  it("reads the latest prompt and turn count from the matched rollout's tail", async () => {
    const cwd = "/Users/example/Projects/acme-workspace";
    const rolloutPath = "/Users/example/.codex/sessions/2026/09/14/rollout-a.jsonl";
    const head =
      JSON.stringify({
        type: "session_meta",
        payload: { cwd, timestamp: "2026-09-14T11:59:00.000Z", session_id: "close" },
      }) +
      "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "First ask" } });
    const tail =
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Second, later ask" } }) +
      "\n" +
      JSON.stringify({
        type: "response_item",
        role: "assistant",
        timestamp: "2026-09-14T11:59:55.000Z",
        text: "Working on it.",
      }) +
      "\n" +
      JSON.stringify({
        type: "response_item",
        role: "assistant",
        timestamp: "2026-09-14T11:59:58.000Z",
        text: "Done.",
      });
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    const io: ActivityEvidenceIo = {
      homeDir: "/Users/example",
      now: () => now,
      readText: async (path, options) => {
        if (path !== rolloutPath) return null;
        if (options.tail) return tail;
        if (options.head) return head;
        return null;
      },
      readDir: async (path) => (path.endsWith("2026/09/14") ? ["rollout-a.jsonl"] : []),
      stat: async () => null,
    };
    const root: RootProcess = { pid: 101, command: "codex exec --brief", cwd, startedAt: now - 20_000 };

    const [session] = await codexAdapter.readSessions([root], io);

    expect(session).toMatchObject({
      id: "codex:close",
      link: "rollout-match",
      activity: {
        latestPrompt: "Second, later ask",
        turns: 2,
        lastAnswerAt: Date.parse("2026-09-14T11:59:58.000Z"),
      },
    });
  });

  it("reads only rollout files whose name is dated near a running root", async () => {
    const cwd = "/Users/example/Projects/acme-workspace";
    const local = (iso: string): string => {
      const date = new Date(iso);
      const pad = (value: number): string => String(value).padStart(2, "0");
      const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      return `${day}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    };
    const nearName = `rollout-${local("2026-09-14T11:59:50.000Z")}-near.jsonl`;
    const farName = `rollout-${local("2026-09-14T08:00:00.000Z")}-far.jsonl`;
    const { io, calls, now } = createIo({}, new Set(), [nearName, farName]);
    const root: RootProcess = { pid: 101, command: "codex exec --brief", cwd, startedAt: now - 20_000 };

    await codexAdapter.readSessions([root], io);

    const read = calls.map((call) => call.path.split("/").at(-1));
    expect(read).toContain(nearName);
    expect(read).not.toContain(farName);
  });

  it("falls back to process-only for cwd mismatches and excludes sandbox/helpers", async () => {
    const { io } = createIo({
      "/Users/example/.codex/sessions/2026/09/14/rollout-a.jsonl": JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/other", timestamp: "2026-09-14T12:00:00.000Z", session_id: "wrong" },
      }),
    });
    const [session] = await codexAdapter.readSessions(
      [
        {
          pid: 102,
          command: "codex",
          cwd: "/Users/example/project",
          startedAt: Date.parse("2026-09-14T12:00:00.000Z"),
        },
      ],
      io,
    );

    expect(session).toMatchObject({ id: "codex:pid:102", name: "Codex", link: "process-only" });
    expect(codexAdapter.isRoot("codex sandbox --help")).toBe(false);
    expect(codexAdapter.isRoot("codex-code-mode-host")).toBe(false);
    expect(codexAdapter.isRoot("/Applications/Codex.app/Contents/MacOS/Codex")).toBe(false);
  });

  it("links live desktop conversations to the host pid and chat title", async () => {
    const hostPid = 200;
    const childPid = 201;
    const { io } = createIo(
      {
        "/Users/example/.codex/process_manager/chat_processes.json": JSON.stringify([
          { osPid: childPid, cwd: "/Users/example/project", conversationId: "conversation-1", chatTitle: "Brief 19" },
        ]),
      },
      new Set([hostPid, childPid]),
    );

    const [session] = await codexAdapter.readSessions(
      [
        {
          pid: hostPid,
          command: "codex app-server --listen",
          cwd: "/Users/example",
          startedAt: 1,
        },
      ],
      io,
    );

    expect(session).toMatchObject({
      id: "codex:conversation:conversation-1",
      pid: hostPid,
      entrypoint: "app",
      name: "Brief 19",
      processPids: [childPid],
      link: "session-file",
    });
  });
});

describe("Codex activity adapter — subcommand detection", () => {
  it("recognises the desktop app-server behind -c options and codex exec", () => {
    const appServer =
      "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled";
    expect(codexAdapter.entrypoint(appServer)).toBe("app");
    expect(codexAdapter.entrypoint("node /opt/homebrew/bin/codex exec -m gpt-5.6-luna")).toBe("exec");
    expect(codexAdapter.isRoot("node /opt/homebrew/bin/codex exec -m gpt-5.6-luna")).toBe(true);
    expect(codexAdapter.entrypoint("codex exec -m gpt-5.6-luna --config x")).toBe("exec");
    expect(codexAdapter.isRoot('codex sandbox -c shell_environment_policy.inherit="all"')).toBe(false);
  });
});
