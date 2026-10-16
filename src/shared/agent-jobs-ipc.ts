import { assertKeys, assertRecord } from "./operations-ipc-parser-utils";

export const AGENT_JOBS_IPC_CHANNELS = {
  start: "omni:jobs:start",
  list: "omni:jobs:list",
  stop: "omni:jobs:stop",
} as const;

export type AgentJobStatus = "running" | "done" | "stopped" | "failed";
export type AgentJob = Readonly<{
  jobId: string;
  job: "compose";
  projectId: string;
  startedAt: number;
  endedAt?: number;
  status: AgentJobStatus;
  doing?: string;
  turns: number;
  toolCalls: number;
  tokens: Readonly<{ input: number; output: number }>;
  context: Readonly<{ estimate: number; window: number; peak?: number }>;
  costUsd: number;
  requestIds: readonly string[];
  summary?: string;
  reason?: string;
}>;
export type AgentJobStartRequest = Readonly<{ job: "compose"; projectId: string; grantHandle: string }>;
export type AgentJobStartResponse = Readonly<{ jobId: string }> | Readonly<{ status: "unavailable"; reason: string }>;
export type AgentJobListResponse = Readonly<{ jobs: readonly AgentJob[] }>;
export type AgentJobStopRequest = Readonly<{ jobId: string }>;
export type AgentJobStopResponse = Readonly<{ status: "stopping" | "missing" }>;

export function formatAgentJobContext(context: Readonly<{ estimate: number; window: number }>): string {
  return `~${Math.round(context.estimate / 1_000)} k / ${Math.round(context.window / 1_000)} k`;
}

export interface AgentJobsDesktopApi {
  startAgentJob(request: AgentJobStartRequest): Promise<AgentJobStartResponse>;
  listAgentJobs(): Promise<AgentJobListResponse>;
  stopAgentJob(request: AgentJobStopRequest): Promise<AgentJobStopResponse>;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function money(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\r\n\u0000]/u.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, label, max);
}

function parseJob(value: unknown): AgentJob {
  const item = assertRecord(value, "Agent job");
  assertKeys(
    item,
    [
      "jobId",
      "job",
      "projectId",
      "startedAt",
      "endedAt",
      "status",
      "doing",
      "turns",
      "toolCalls",
      "tokens",
      "context",
      "costUsd",
      "requestIds",
      "summary",
      "reason",
    ],
    "Agent job",
  );
  if (item.job !== "compose") throw new Error("Agent job kind is invalid.");
  if (!["running", "done", "stopped", "failed"].includes(item.status as string))
    throw new Error("Agent job status is invalid.");
  const tokens = assertRecord(item.tokens, "Agent job tokens");
  assertKeys(tokens, ["input", "output"], "Agent job tokens");
  const context = assertRecord(item.context, "Agent job context");
  assertKeys(context, ["estimate", "window", "peak"], "Agent job context");
  if (!Array.isArray(item.requestIds)) throw new Error("Agent job request ids are invalid.");
  return {
    jobId: id(item.jobId, "Agent job id"),
    job: "compose",
    projectId: id(item.projectId, "Project id"),
    startedAt: count(item.startedAt, "Agent job start"),
    ...(item.endedAt === undefined ? {} : { endedAt: count(item.endedAt, "Agent job end") }),
    status: item.status as AgentJobStatus,
    ...(item.doing === undefined ? {} : { doing: text(item.doing, "Agent job doing", 120) }),
    turns: count(item.turns, "Agent job turns"),
    toolCalls: count(item.toolCalls, "Agent job tool calls"),
    tokens: {
      input: count(tokens.input, "Agent job input tokens"),
      output: count(tokens.output, "Agent job output tokens"),
    },
    context: {
      estimate: count(context.estimate, "Agent job context estimate"),
      window: count(context.window, "Agent job context window"),
      ...(context.peak === undefined ? {} : { peak: count(context.peak, "Agent job context peak") }),
    },
    costUsd: money(item.costUsd, "Agent job cost"),
    requestIds: item.requestIds.map((requestId) => id(requestId, "Agent job request id")),
    ...(item.summary === undefined ? {} : { summary: text(item.summary, "Agent job summary", 400) }),
    ...(item.reason === undefined ? {} : { reason: text(item.reason, "Agent job reason", 500) }),
  };
}

export function parseAgentJobStartRequest(value: unknown): AgentJobStartRequest {
  const request = assertRecord(value, "Agent job start request");
  assertKeys(request, ["job", "projectId", "grantHandle"], "Agent job start request");
  if (request.job !== "compose") throw new Error("Agent job is invalid.");
  return {
    job: "compose",
    projectId: id(request.projectId, "Project id"),
    grantHandle: id(request.grantHandle, "Grant handle"),
  };
}

export function parseEmptyAgentJobsRequest(value: unknown): void {
  const request = assertRecord(value, "Agent jobs request");
  assertKeys(request, [], "Agent jobs request");
}

export function parseAgentJobStartResponse(value: unknown): AgentJobStartResponse {
  const response = assertRecord(value, "Agent job start response");
  if (response.status === "unavailable") {
    assertKeys(response, ["status", "reason"], "Agent job start response");
    return { status: "unavailable", reason: text(response.reason, "Agent job reason", 500) };
  }
  assertKeys(response, ["jobId"], "Agent job start response");
  return { jobId: id(response.jobId, "Agent job id") };
}

export function parseAgentJobListResponse(value: unknown): AgentJobListResponse {
  const response = assertRecord(value, "Agent job list response");
  assertKeys(response, ["jobs"], "Agent job list response");
  if (!Array.isArray(response.jobs)) throw new Error("Agent jobs are invalid.");
  return { jobs: response.jobs.map(parseJob) };
}

export function parseAgentJobStopRequest(value: unknown): AgentJobStopRequest {
  const request = assertRecord(value, "Agent job stop request");
  assertKeys(request, ["jobId"], "Agent job stop request");
  return { jobId: id(request.jobId, "Agent job id") };
}

export function parseAgentJobStopResponse(value: unknown): AgentJobStopResponse {
  const response = assertRecord(value, "Agent job stop response");
  assertKeys(response, ["status"], "Agent job stop response");
  if (response.status !== "stopping" && response.status !== "missing") throw new Error("Agent stop status is invalid.");
  return { status: response.status };
}
