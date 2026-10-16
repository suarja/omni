import type { AgentSession, ActivityEntrypoint, ActivityHarness } from "../../shared/activity-ipc";

export type RootProcess = Readonly<{
  pid: number;
  command: string;
  cwd?: string;
  startedAt: number;
}>;

export type ActivityEvidenceIo = Readonly<{
  homeDir: string;
  now(): number;
  readText(path: string, options: { head?: number; tail?: number }): Promise<string | null>;
  readDir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number } | null>;
  isProcessAlive?: (pid: number) => boolean;
}>;

export type ActivityHarnessAdapter = Readonly<{
  harness: ActivityHarness;
  isRoot(command: string): boolean;
  entrypoint(command: string): ActivityEntrypoint;
  readSessions(roots: readonly RootProcess[], io: ActivityEvidenceIo): Promise<AgentSession[]>;
}>;

export { claudeCodeAdapter } from "./claude-code";
export { codexAdapter } from "./codex";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";

export const activityHarnessAdapters: readonly ActivityHarnessAdapter[] = [claudeCodeAdapter, codexAdapter];
