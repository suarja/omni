import { parseApplyOperationResponse } from "./operations-ipc";
import { parsePlan } from "./activity-process-ipc";
import { PROCESS_FULL_COMMAND_MAX_LENGTH } from "./activity-ipc";
import type {
  AgentName,
  ActivityEntrypoint,
  SessionLink,
  ProcessFlag,
  AgentSession,
  SessionActivity,
  AgentProcess,
  Worktree,
  ActivitySnapshot,
  ActivitySnapshotResponse,
  ActivityPreviewResponse,
  ActivityApplyResponse,
  ActivitySimulationRequest,
  ActivitySimulationResponse,
} from "./activity-ipc";
import { parseAgentJobListResponse } from "./agent-jobs-ipc";

export type RecordValue = Record<string, unknown>;

export function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as RecordValue;
}

export function assertKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`${label} has an unexpected field "${unexpected}".`);
  }
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

export function opaque(value: unknown, label: string): string {
  const result = text(value, label);
  if (result.includes("/") || result.includes("\\") || result.includes("..")) {
    throw new Error(`${label} must be opaque.`);
  }
  return result;
}

// A working directory is a path by nature: "~" or "~/…" inside the home directory, an absolute
// path outside it ("/", "/private/tmp/…"). Traversal segments and control characters are refused.
export function workingDirectory(value: unknown, label: string): string {
  const result = text(value, label).replaceAll("\\", "/");
  if (result === "/" || result === "~") return result;
  const isRooted = result.startsWith("/") || result.startsWith("~/") || /^[A-Za-z]:\//u.test(result);
  if (!isRooted) throw new Error(`${label} must be a rooted path.`);
  const parts = result.split("/").slice(1);
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is not a safe display path.`);
  }
  return result;
}

// The task is the user's own first prompt line: free text, bounded, may start with a path.
function taskText(value: unknown, label: string): string {
  const result = text(value, label);
  if (result.length > 160) throw new Error(`${label} is too long.`);
  return result;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  const result = text(value, label);
  if (result.length > maxLength) throw new Error(`${label} is too long.`);
  return result;
}

function boolValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function parseSessionActivityTool(value: unknown): NonNullable<SessionActivity["lastTool"]> {
  const item = record(value, "Session last tool");
  assertKeys(item, ["name", "target"], "Session last tool");
  return {
    name: boundedText(item.name, "Session last tool name", 100),
    ...(item.target === undefined ? {} : { target: boundedText(item.target, "Session last tool target", 400) }),
  };
}

function parseSessionActivity(value: unknown): SessionActivity {
  const item = record(value, "Session activity");
  assertKeys(
    item,
    [
      "firstPrompt",
      "latestPrompt",
      "latestPromptAt",
      "lastTool",
      "turns",
      "tailTruncated",
      "lastAnswerAt",
      "subagents",
    ],
    "Session activity",
  );
  return {
    ...(item.firstPrompt === undefined
      ? {}
      : { firstPrompt: boundedText(item.firstPrompt, "Session first prompt", 600) }),
    ...(item.latestPrompt === undefined
      ? {}
      : { latestPrompt: boundedText(item.latestPrompt, "Session latest prompt", 600) }),
    ...(item.latestPromptAt === undefined
      ? {}
      : { latestPromptAt: numberValue(item.latestPromptAt, "Session latest prompt time", true) }),
    ...(item.lastTool === undefined ? {} : { lastTool: parseSessionActivityTool(item.lastTool) }),
    ...(item.turns === undefined ? {} : { turns: numberValue(item.turns, "Session turns", true) }),
    ...(item.tailTruncated === undefined
      ? {}
      : { tailTruncated: boolValue(item.tailTruncated, "Session tail truncated flag") }),
    ...(item.lastAnswerAt === undefined
      ? {}
      : { lastAnswerAt: numberValue(item.lastAnswerAt, "Session last answer time", true) }),
    ...(item.subagents === undefined ? {} : { subagents: numberValue(item.subagents, "Session sub-agents", true) }),
  };
}

function displayText(value: unknown, label: string): string {
  const result = text(value, label);
  if (result.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(result)) {
    throw new Error(`${label} must not contain an absolute path.`);
  }
  return result;
}

export function relativeDisplay(value: unknown, label: string): string {
  const result = text(value, label).replaceAll("\\", "/");
  if (
    result.startsWith("/") ||
    /^[A-Za-z]:\//u.test(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a safe relative path.`);
  }
  return result;
}

export function numberValue(value: unknown, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseFlags(value: unknown, label: string): ProcessFlag[] {
  if (
    !Array.isArray(value) ||
    value.some((flag) => !["runaway", "duplicate", "orphan"].includes(flag as ProcessFlag))
  ) {
    throw new Error(`${label} are invalid.`);
  }
  return value as ProcessFlag[];
}

function parseProcessState(value: unknown): "running" | "sleeping" | "stopped" | "zombie" | "other" {
  if (!["running", "sleeping", "stopped", "zombie", "other"].includes(value as string)) {
    throw new Error("Process state is invalid.");
  }
  return value as "running" | "sleeping" | "stopped" | "zombie" | "other";
}

function parseProcess(value: unknown): AgentProcess {
  const item = record(value, "Agent process");
  assertKeys(
    item,
    [
      "pid",
      "ppid",
      "agent",
      "name",
      "command",
      "fullCommand",
      "sessionId",
      "cpuPercent",
      "elapsedSeconds",
      "rssMb",
      "depth",
      "flags",
      "startedAt",
      "cwd",
      "state",
    ],
    "Agent process",
  );
  if (!["claude-code", "codex", "cursor", "opencode", "omni", "simulation"].includes(item.agent as string)) {
    throw new Error("Agent name is invalid.");
  }
  return {
    pid: numberValue(item.pid, "Process pid", true),
    ppid: numberValue(item.ppid, "Process ppid", true),
    agent: item.agent as AgentName,
    name: displayText(item.name, "Process name"),
    command: displayText(item.command, "Process command"),
    ...(item.fullCommand === undefined
      ? {}
      : { fullCommand: boundedText(item.fullCommand, "Process full command", PROCESS_FULL_COMMAND_MAX_LENGTH) }),
    ...(item.sessionId === undefined ? {} : { sessionId: opaque(item.sessionId, "Process session id") }),
    cpuPercent: numberValue(item.cpuPercent, "Process CPU"),
    elapsedSeconds: numberValue(item.elapsedSeconds, "Process elapsed time", true),
    rssMb: numberValue(item.rssMb, "Process memory"),
    depth: numberValue(item.depth, "Process depth", true),
    flags: parseFlags(item.flags, "Process flags"),
    ...(item.startedAt === undefined ? {} : { startedAt: numberValue(item.startedAt, "Process start", true) }),
    ...(item.cwd === undefined ? {} : { cwd: workingDirectory(item.cwd, "Process working directory") }),
    ...(item.state === undefined ? {} : { state: parseProcessState(item.state) }),
  };
}

function parseSession(value: unknown): AgentSession {
  const item = record(value, "Agent session");
  assertKeys(
    item,
    [
      "id",
      "harness",
      "pid",
      "entrypoint",
      "name",
      "task",
      "title",
      "activity",
      "cwd",
      "projectId",
      "projectName",
      "branch",
      "startedAt",
      "lastActivityAt",
      "link",
      "processPids",
      "worktreeIds",
      "totals",
      "flags",
      "job",
    ],
    "Agent session",
  );
  if (item.harness !== "claude-code" && item.harness !== "codex" && item.harness !== "omni") {
    throw new Error("Session harness is invalid.");
  }
  if (!["desktop", "terminal", "exec", "app"].includes(item.entrypoint as string)) {
    throw new Error("Session entrypoint is invalid.");
  }
  if (!["session-file", "rollout-match", "process-only"].includes(item.link as string)) {
    throw new Error("Session evidence link is invalid.");
  }
  const totals = record(item.totals, "Session totals");
  assertKeys(totals, ["cpuPercent", "rssMb"], "Session totals");
  if (!Array.isArray(item.processPids) || item.processPids.some((pid) => !Number.isSafeInteger(pid) || pid < 0)) {
    throw new Error("Session process pids are invalid.");
  }
  if (!Array.isArray(item.worktreeIds)) {
    throw new Error("Session worktree ids are invalid.");
  }
  return {
    id: opaque(item.id, "Session id"),
    harness: item.harness,
    pid: numberValue(item.pid, "Session pid", true),
    entrypoint: item.entrypoint as ActivityEntrypoint,
    name: text(item.name, "Session name"),
    ...(item.task === undefined ? {} : { task: taskText(item.task, "Session task") }),
    ...(item.title === undefined ? {} : { title: boundedText(item.title, "Session title", 200) }),
    ...(item.activity === undefined ? {} : { activity: parseSessionActivity(item.activity) }),
    cwd: workingDirectory(item.cwd, "Session cwd"),
    ...(item.projectId === undefined ? {} : { projectId: opaque(item.projectId, "Session project id") }),
    ...(item.projectName === undefined ? {} : { projectName: displayText(item.projectName, "Session project name") }),
    ...(item.branch === undefined ? {} : { branch: displayText(item.branch, "Session branch") }),
    startedAt: numberValue(item.startedAt, "Session start", true),
    ...(item.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: numberValue(item.lastActivityAt, "Session last activity", true) }),
    link: item.link as SessionLink,
    processPids: item.processPids as number[],
    worktreeIds: item.worktreeIds.map((id) => relativeDisplay(id, "Session worktree id")),
    totals: {
      cpuPercent: numberValue(totals.cpuPercent, "Session CPU"),
      rssMb: numberValue(totals.rssMb, "Session memory"),
    },
    flags: parseFlags(item.flags, "Session flags"),
    ...(item.job === undefined ? {} : { job: parseAgentJobListResponse({ jobs: [item.job] }).jobs[0] }),
  };
}

function parseWorktree(value: unknown): Worktree {
  const item = record(value, "Worktree");
  assertKeys(
    item,
    [
      "projectId",
      "projectName",
      "id",
      "branch",
      "head",
      "kind",
      "dirty",
      "ageDays",
      "lastActivityDays",
      "isMain",
      "sessionId",
    ],
    "Worktree",
  );
  if (item.kind !== "git-worktree" && item.kind !== "folder") {
    throw new Error("Worktree kind is invalid.");
  }
  if (item.dirty !== true && item.dirty !== false && item.dirty !== "unknown") {
    throw new Error("Worktree dirty state is invalid.");
  }
  if (typeof item.isMain !== "boolean") {
    throw new Error("Worktree main state is invalid.");
  }
  return {
    projectId: opaque(item.projectId, "Worktree project id"),
    projectName: displayText(item.projectName, "Worktree project name"),
    id: relativeDisplay(item.id, "Worktree id"),
    ...(item.branch === undefined ? {} : { branch: displayText(item.branch, "Worktree branch") }),
    ...(item.head === undefined ? {} : { head: opaque(item.head, "Worktree head") }),
    kind: item.kind,
    dirty: item.dirty,
    ageDays: numberValue(item.ageDays, "Worktree age", true),
    lastActivityDays: numberValue(item.lastActivityDays, "Worktree activity", true),
    isMain: item.isMain,
    ...(item.sessionId === undefined ? {} : { sessionId: opaque(item.sessionId, "Worktree session id") }),
  };
}

// Absent (older callers, and the pre-sessions "legacy empty" shape below, predate the
// platform seam and were always macOS) defaults to supported; present values are parsed
// strictly, matching every other field in this file.
function parsePlatformSupported(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error("Activity snapshot platform support flag is invalid.");
  return value;
}

function parseSnapshot(value: unknown): ActivitySnapshot {
  const item = record(value, "Activity snapshot");
  assertKeys(item, ["sessions", "processes", "worktrees", "platformSupported"], "Activity snapshot");
  const platformSupported = parsePlatformSupported(item.platformSupported);
  const legacyEmpty =
    item.sessions === undefined &&
    Array.isArray(item.processes) &&
    Array.isArray(item.worktrees) &&
    item.processes.length === 0 &&
    item.worktrees.length === 0;
  if (legacyEmpty) {
    return { sessions: [], processes: [], worktrees: [], platformSupported };
  }
  if (!Array.isArray(item.sessions) || !Array.isArray(item.processes) || !Array.isArray(item.worktrees)) {
    throw new Error("Activity snapshot lists are invalid.");
  }
  return {
    sessions: item.sessions.map(parseSession),
    processes: item.processes.map(parseProcess),
    worktrees: item.worktrees.map(parseWorktree),
    platformSupported,
  };
}

export function parseEmptyActivityRequest(value: unknown): void {
  const item = record(value, "Activity request");
  assertKeys(item, [], "Activity request");
}

export function parseActivityApplyRequest(value: unknown): Readonly<{ planId: string }> {
  const item = record(value, "Activity apply request");
  assertKeys(item, ["planId"], "Activity apply request");
  return { planId: opaque(item.planId, "Activity plan id") };
}

export function parseActivitySimulationRequest(value: unknown): ActivitySimulationRequest {
  const item = record(value, "Activity simulation request");
  if (item.kind === "runaway-process") {
    assertKeys(item, ["kind"], "Activity simulation request");
    return { kind: item.kind };
  }
  if (item.kind === "stale-worktree") {
    assertKeys(item, ["kind", "projectId"], "Activity simulation request");
    return { kind: item.kind, projectId: opaque(item.projectId, "Project id") };
  }
  throw new Error("Activity simulation kind is invalid.");
}

export function parseActivitySnapshotResponse(value: unknown): ActivitySnapshotResponse {
  const item = record(value, "Activity snapshot response");
  if (item.status === "unavailable") {
    assertKeys(item, ["status", "diagnostic"], "Activity snapshot response");
    return { status: "unavailable", diagnostic: text(item.diagnostic, "Activity diagnostic") };
  }
  assertKeys(item, ["status", "snapshot"], "Activity snapshot response");
  if (item.status !== "ready") {
    throw new Error("Activity snapshot status is invalid.");
  }
  return { status: "ready", snapshot: parseSnapshot(item.snapshot) };
}

export function parseActivityPreviewResponse(value: unknown): ActivityPreviewResponse {
  const item = record(value, "Activity preview response");
  if (item.status === "blocked") {
    assertKeys(item, ["status", "reason", "diagnostic"], "Activity preview response");
    return {
      status: "blocked",
      reason: text(item.reason, "Activity block reason"),
      diagnostic: text(item.diagnostic, "Activity diagnostic"),
    };
  }
  assertKeys(item, ["status", "plan"], "Activity preview response");
  if (item.status !== "ready") {
    throw new Error("Activity preview status is invalid.");
  }
  return { status: "ready", plan: parsePlan(item.plan) };
}

export function parseActivitySimulationResponse(value: unknown): ActivitySimulationResponse {
  const item = record(value, "Activity simulation response");
  if (item.status === "unavailable") {
    assertKeys(item, ["status"], "Activity simulation response");
    return { status: "unavailable" };
  }
  assertKeys(item, ["status", "kind", "pid", "path"], "Activity simulation response");
  if (item.status !== "available" || (item.kind !== "runaway-process" && item.kind !== "stale-worktree")) {
    throw new Error("Activity simulation response is invalid.");
  }
  return {
    status: "available",
    kind: item.kind,
    ...(item.pid === undefined ? {} : { pid: numberValue(item.pid, "Simulation pid", true) }),
    ...(item.path === undefined ? {} : { path: text(item.path, "Simulation path") }),
  };
}

export function parseActivityApplyResponse(value: unknown): ActivityApplyResponse {
  const item = record(value, "Activity apply response");
  assertKeys(item, ["status", "receipt"], "Activity apply response");
  if (item.status !== "applied" && item.status !== "failed") {
    throw new Error("Activity apply status is invalid.");
  }
  return parseApplyOperationResponse(item);
}
