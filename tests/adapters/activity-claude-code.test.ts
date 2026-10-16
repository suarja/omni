import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { claudeCodeAdapter, claudeTranscriptPath } from "../../src/adapters/activity/claude-code";
import type { ActivityEvidenceIo, RootProcess } from "../../src/adapters/activity";

function createIo(files: Record<string, string>, now = Date.parse("2026-09-14T12:00:00.000Z")) {
  const calls: { path: string; options: { head?: number; tail?: number } }[] = [];
  const io = {
    homeDir: "/Users/example",
    now: () => now,
    readText: async (path: string, options: { head?: number; tail?: number }) => {
      calls.push({ path, options });
      return files[path] ?? null;
    },
    readDir: async () => [],
    stat: async () => null,
  };
  return { io, calls };
}

describe("Claude Code activity adapter", () => {
  it("links the session file and parses bounded transcript head and tail evidence", async () => {
    const cwd = "/Users/example/Projects/acme-workspace";
    const sessionPath = "/Users/example/.claude/sessions/123.json";
    const transcriptPath = "/Users/example/.claude/projects/-Users-example-Projects-acme-workspace/session-1.jsonl";
    const { io, calls } = createIo({
      [sessionPath]: JSON.stringify({ pid: 123, sessionId: "session-1", cwd, startedAt: "2026-09-14T11:59:00.000Z" }),
      [transcriptPath]: JSON.stringify({
        slug: "iterative-sprouting-lamport",
        gitBranch: "feat/activity",
        cwd,
        timestamp: "2026-09-14T12:00:00.000Z",
      }),
    });
    const head =
      JSON.stringify({ type: "user", message: { content: "<system wrapper>\nMission: fix\u0001 activity" } }) +
      "\n" +
      JSON.stringify({ type: "user", message: { content: "Mission: fix\u0001 activity" } });
    const originalRead = io.readText;
    io.readText = async (path: string, options: { head?: number; tail?: number }) => {
      calls.push({ path, options });
      if (path === transcriptPath && options.head) return head;
      return originalRead(path, options);
    };
    const root: RootProcess = {
      pid: 123,
      command:
        "/Users/example/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude --output-format stream-json",
      cwd,
      startedAt: Date.parse("2026-09-14T11:59:00.000Z"),
    };

    const [session] = await claudeCodeAdapter.readSessions([root], io);

    expect(session).toMatchObject({
      id: "claude-code:session-1",
      link: "session-file",
      entrypoint: "desktop",
      name: "iterative-sprouting-lamport",
      task: "Mission: fix activity",
      branch: "feat/activity",
      cwd: "~/Projects/acme-workspace",
      startedAt: Date.parse("2026-09-14T11:59:00.000Z"),
      lastActivityAt: Date.parse("2026-09-14T12:00:00.000Z"),
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        { path: sessionPath, options: { head: 32 * 1024 } },
        { path: transcriptPath, options: { head: 128 * 1024 } },
        { path: transcriptPath, options: { tail: 256 * 1024 } },
      ]),
    );
  });

  it("uses the terminal entrypoint and emits process-only sessions for missing evidence", async () => {
    const { io } = createIo({});
    const root: RootProcess = { pid: 456, command: "claude", cwd: "/Users/example/project", startedAt: 10 };
    const [session] = await claudeCodeAdapter.readSessions([root], io);

    expect(session).toMatchObject({
      id: "claude-code:pid:456",
      entrypoint: "terminal",
      name: "Claude Code",
      link: "process-only",
      cwd: "~/project",
      startedAt: 10,
    });
  });

  it("computes the observed Claude project slug: slashes and spaces become dashes, dots stay", () => {
    expect(claudeCodeAdapter.isRoot("claude")).toBe(true);
    expect(claudeTranscriptPath("/Users/example", "/Users/example/Downloads/Sample Files", "s1")).toBe(
      "/Users/example/.claude/projects/-Users-example-Downloads-Sample-Files/s1.jsonl",
    );
    expect(claudeTranscriptPath("/Users/example", "/Users/example/App/acme-workspace/.worktrees/feat", "s2")).toBe(
      "/Users/example/.claude/projects/-Users-example-App-acme-workspace-.worktrees-feat/s2.jsonl",
    );
  });
});

describe("Claude Code activity adapter — real-shape refinements", () => {
  it("does not treat the desktop app or its helpers as sessions", () => {
    expect(claudeCodeAdapter.isRoot("/Applications/Claude.app/Contents/MacOS/Claude")).toBe(false);
    expect(
      claudeCodeAdapter.isRoot(
        "/Applications/Claude.app/Contents/Helpers/Claude iOS Sim.app/Contents/MacOS/claude-ios-sim",
      ),
    ).toBe(false);
    expect(
      claudeCodeAdapter.isRoot(
        "/Users/example/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude --output-format stream-json",
      ),
    ).toBe(true);
  });

  it("reads a slash command as the task and skips injected (isMeta) skill bodies", async () => {
    const cwd = "/Users/example/Projects/acme-web";
    const transcript = [
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { role: "user", content: "Base directory for this skill: /x" },
      }),
      JSON.stringify({
        type: "user",
        origin: { kind: "human" },
        message: {
          role: "user",
          content: "<command-message>grill-me</command-message>\n<command-name>/grill-me</command-name>",
        },
      }),
      JSON.stringify({ slug: "rosy-forging-sky", gitBranch: "dev", cwd, timestamp: "2026-09-14T12:00:00.000Z" }),
    ].join("\n");
    const files: Record<string, string> = {
      "/Users/example/.claude/sessions/52208.json": JSON.stringify({
        pid: 52208,
        sessionId: "c23c388b",
        cwd,
        startedAt: 1,
      }),
      [claudeTranscriptPath("/Users/example", cwd, "c23c388b")]: transcript,
    };
    const io = {
      homeDir: "/Users/example",
      now: () => 0,
      readText: async (path: string) => files[path] ?? null,
      readDir: async () => [],
      stat: async () => null,
    };
    const [session] = await claudeCodeAdapter.readSessions([{ pid: 52208, command: "claude", cwd, startedAt: 1 }], io);
    expect(session).toMatchObject({ name: "rosy-forging-sky", task: "/grill-me", link: "session-file" });
  });
});

describe("Claude Code activity adapter — iteration 3 evidence (title and activity)", () => {
  it("reads the title, first/latest prompt, last tool, turn count and sub-agent count from the transcript", async () => {
    const cwd = "/Users/example/Projects/acme-workspace/omni-desktop";
    const sessionId = "s-iter3";
    const transcript = readFileSync(
      join(__dirname, "..", "fixtures", "activity", "claude-code", "transcript-iteration-3.jsonl"),
      "utf8",
    );
    const files: Record<string, string> = {
      "/Users/example/.claude/sessions/777.json": JSON.stringify({ pid: 777, sessionId, cwd, startedAt: 1 }),
      [claudeTranscriptPath("/Users/example", cwd, sessionId)]: transcript,
    };
    const io: ActivityEvidenceIo = {
      homeDir: "/Users/example",
      now: () => Date.parse("2026-09-14T12:00:00.000Z"),
      readText: async (path: string) => files[path] ?? null,
      readDir: async () => [],
      stat: async () => null,
    };
    const root: RootProcess = { pid: 777, command: "claude", cwd, startedAt: 1 };

    const [session] = await claudeCodeAdapter.readSessions([root], io);

    expect(session).toMatchObject({
      link: "session-file",
      task: "Inspect the sample activity data and update the fixture.",
      title: "Sample activity inspection",
      activity: {
        firstPrompt: "Inspect the sample activity data and update the fixture.",
        latestPrompt: "Check the synthetic fixture and run the tests.",
        latestPromptAt: Date.parse("2026-09-14T09:02:05.000Z"),
        lastTool: { name: "Edit", target: "tests/fixtures/activity/claude-code/transcript-iteration-3.jsonl" },
        turns: 12,
        tailTruncated: false,
        lastAnswerAt: Date.parse("2026-09-14T09:02:15.000Z"),
        subagents: 2,
      },
    });
  });
});
