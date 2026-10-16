import type { OperationReceipt } from "./operations-ipc";
import type { AgentJob } from "./agent-jobs-ipc";

export const ACTIVITY_IPC_CHANNELS = {
  snapshot: "omni:activity:snapshot",
  preview: "omni:activity:preview",
  apply: "omni:activity:apply",
  simulate: "omni:activity:simulate",
  ports: "omni:activity:ports",
  openTerminal: "omni:activity:open-terminal",
} as const;

export type AgentName = "claude-code" | "codex" | "cursor" | "opencode" | "omni" | "simulation";
export type ActivityHarness = "claude-code" | "codex" | "omni";
export type ActivityEntrypoint = "desktop" | "terminal" | "exec" | "app";
export type SessionLink = "session-file" | "rollout-match" | "process-only";
export type ProcessFlag = "runaway" | "duplicate" | "orphan";
export type ProcessState = "running" | "sleeping" | "stopped" | "zombie" | "other";
export type ProcessSignalAction = "kill" | "pause" | "resume";

// Deterministic evidence read from a transcript tail (Claude Code) or rollout tail (Codex, best
// effort): every field is independently optional — set only when the evidence carried it.
export type SessionActivity = Readonly<{
  firstPrompt?: string;
  latestPrompt?: string;
  latestPromptAt?: number;
  lastTool?: Readonly<{ name: string; target?: string }>;
  turns?: number;
  // True when the tail read hit the byte window before the start of the file: `turns` is then
  // a lower bound ("at least N"), not an exact count.
  tailTruncated?: boolean;
  lastAnswerAt?: number;
  subagents?: number;
}>;

export type AgentSession = Readonly<{
  id: string;
  harness: ActivityHarness;
  pid: number;
  entrypoint: ActivityEntrypoint;
  name: string;
  task?: string;
  // The session title set in the desktop app (Claude Code's `custom-title` event), when one
  // exists — replaces `name` as the row/page head label.
  title?: string;
  activity?: SessionActivity;
  cwd: string;
  projectId?: string;
  projectName?: string;
  branch?: string;
  startedAt: number;
  lastActivityAt?: number;
  link: SessionLink;
  processPids: readonly number[];
  worktreeIds: readonly string[];
  totals: Readonly<{
    cpuPercent: number;
    rssMb: number;
  }>;
  flags: readonly ProcessFlag[];
  job?: AgentJob;
}>;

/** One bound for the producer (`activity-processes.ts`) and the parser: longer commands end with "…". */
export const PROCESS_FULL_COMMAND_MAX_LENGTH = 4_000;

export type AgentProcess = Readonly<{
  pid: number;
  ppid: number;
  agent: AgentName;
  name: string;
  command: string;
  // The full command with its options, home-anonymised, bounded to
  // `PROCESS_FULL_COMMAND_MAX_LENGTH` (a process launched with a whole prompt as its argument
  // must never make the snapshot unparseable): shown in the row's Details disclosure. Optional
  // so older or hand-built snapshots without it still parse; the renderer falls back to `command`.
  fullCommand?: string;
  sessionId?: string;
  cpuPercent: number;
  elapsedSeconds: number;
  rssMb: number;
  depth: number;
  flags: readonly ProcessFlag[];
  startedAt?: number;
  cwd?: string;
  state?: ProcessState;
}>;

export type Worktree = Readonly<{
  projectId: string;
  projectName: string;
  id: string;
  branch?: string;
  head?: string;
  kind: "git-worktree" | "folder";
  dirty: boolean | "unknown";
  ageDays: number;
  lastActivityDays: number;
  isMain: boolean;
  sessionId?: string;
}>;

export type ActivitySnapshot = Readonly<{
  sessions: readonly AgentSession[];
  processes: readonly AgentProcess[];
  worktrees: readonly Worktree[];
  // False when the process/terminal/gateway seam has no implementation for this OS (see
  // `src/main/platform/`); sessions are still populated from harness evidence, which is
  // OS-neutral, but the process tree is always empty in that case.
  platformSupported: boolean;
}>;
export type ActivitySnapshotResponse =
  Readonly<{ status: "ready"; snapshot: ActivitySnapshot }> | Readonly<{ status: "unavailable"; diagnostic: string }>;
export type StopProcessPreviewRequest = Readonly<{ kind: "stop-process"; pid: number }>;
export type SignalProcessPreviewRequest = Readonly<{
  kind: "signal-process";
  pid: number;
  action: ProcessSignalAction;
}>;
export type ReniceProcessPreviewRequest = Readonly<{ kind: "renice-process"; pid: number; nice: 10 | 0 }>;
export type RemoveWorktreePreviewRequest = Readonly<{
  kind: "remove-worktree";
  projectId: string;
  worktreeId: string;
}>;
export type ActivityPreviewRequest =
  StopProcessPreviewRequest | SignalProcessPreviewRequest | ReniceProcessPreviewRequest | RemoveWorktreePreviewRequest;
export type ActivityProcessAction = Readonly<{ pid: number; command: string; cpuPercent: number }>;
export type ActivityProcessPlan = Readonly<{
  planId: string;
  kind: "stop-process";
  displayTarget: string;
  actions: readonly ActivityProcessAction[];
}>;
export type ActivitySignalPlan = Readonly<{
  planId: string;
  kind: "signal-process";
  displayTarget: string;
  action: ProcessSignalAction;
  actions: readonly ActivityProcessAction[];
}>;
export type ActivityRenicePlan = Readonly<{
  planId: string;
  kind: "renice-process";
  displayTarget: string;
  nice: 10 | 0;
  actions: readonly ActivityProcessAction[];
}>;
export type ActivityWorktreePlan = Readonly<{
  planId: string;
  kind: "remove-worktree";
  displayTarget: string;
  actions: readonly Readonly<{
    projectId: string;
    worktreeId: string;
    kind: "git-worktree" | "folder";
  }>[];
}>;
export type ActivityPlan = ActivityProcessPlan | ActivitySignalPlan | ActivityRenicePlan | ActivityWorktreePlan;
export type ActivityPreviewResponse =
  | Readonly<{ status: "ready"; plan: ActivityPlan }>
  | Readonly<{ status: "blocked"; reason: string; diagnostic: string }>;
export type ActivityApplyResponse = Readonly<{
  status: "applied" | "failed";
  receipt: OperationReceipt;
}>;
export type ActivitySimulationRequest =
  Readonly<{ kind: "runaway-process" }> | Readonly<{ kind: "stale-worktree"; projectId: string }>;
export type ActivitySimulationResponse =
  | Readonly<{ status: "available"; kind: ActivitySimulationRequest["kind"]; pid?: number; path?: string }>
  | Readonly<{ status: "unavailable" }>;
export type ActivityPortsRequest = Readonly<{ pids: readonly number[] }>;
export type ActivityPortsResponse = Readonly<{ ports: readonly Readonly<{ pid: number; port: number }>[] }>;
export type ActivityOpenTerminalRequest = Readonly<{ cwd: string }>;
export type ActivityOpenTerminalResponse =
  Readonly<{ status: "opened" }> | Readonly<{ status: "blocked"; diagnostic: string }>;

export {
  parseActivityApplyRequest,
  parseActivityApplyResponse,
  parseActivityPreviewResponse,
  parseActivitySimulationRequest,
  parseActivitySimulationResponse,
  parseActivitySnapshotResponse,
  parseEmptyActivityRequest,
} from "./activity-ipc-parsers";
export {
  parseActivityOpenTerminalRequest,
  parseActivityOpenTerminalResponse,
  parseActivityPortsRequest,
  parseActivityPortsResponse,
  parseActivityPreviewRequest,
} from "./activity-process-ipc";

export interface ActivityDesktopApi {
  getActivitySnapshot(): Promise<ActivitySnapshotResponse>;
  previewActivity(request: ActivityPreviewRequest): Promise<ActivityPreviewResponse>;
  applyActivity(request: Readonly<{ planId: string }>): Promise<ActivityApplyResponse>;
  simulateActivity(request: ActivitySimulationRequest): Promise<ActivitySimulationResponse>;
  getListeningPorts(request: ActivityPortsRequest): Promise<ActivityPortsResponse>;
  openTerminal(request: ActivityOpenTerminalRequest): Promise<ActivityOpenTerminalResponse>;
}
