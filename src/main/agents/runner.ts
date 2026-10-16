import { activeWorkshop } from "../../domain/source-roles";
import { randomUUID } from "node:crypto";

import type { Connection } from "../../shared/ai-gateway-ipc";
import type { AgentJob, AgentJobStartResponse } from "../../shared/agent-jobs-ipc";
import type { FunctionRoutes } from "../../shared/ai-gateway-ipc";
import type { Budget } from "../inference/budget";
import { listModels, type GatewayModel } from "../inference/gateway/models";
import { resolve } from "../inference/gateway/routes";
import type { AgentRouter } from "../agent-gateway/server";
import type { RegistryIpcServices } from "../registry-ipc";
import type { AgentSession } from "../../shared/activity-ipc";
import { createJobHarness, type JobHarness } from "./harness";
import { composeJob } from "./jobs/compose";
import type { JobGrants } from "./tools";
import { calculateContextBudget, maxTokensPerTurn } from "./context-budget";

const NO_CONNECTION_REASON = "Add a connection in Settings · AI.";

type MutableJob = {
  job: AgentJob;
  harness?: JobHarness;
};

export type AgentJobRunnerOptions = Readonly<{
  router: AgentRouter;
  registry: RegistryIpcServices;
  budget: Budget;
  getConnection: () => Promise<Connection | undefined>;
  readKey: () => Promise<string | undefined>;
  getModels?: (connection: Connection) => Promise<readonly GatewayModel[]>;
  getFunctions?: () => Promise<FunctionRoutes>;
  appVersion?: string;
  now?: () => number;
  streamFn?: Parameters<typeof createJobHarness>[0]["streamFn"];
}>;

export type AgentJobRunner = Readonly<{
  start(request: Readonly<{ job: "compose"; projectId: string; grantHandle: string }>): Promise<AgentJobStartResponse>;
  list(): readonly AgentJob[];
  stop(jobId: string): Readonly<{ status: "stopping" | "missing" }>;
  activitySessions(): readonly AgentSession[];
}>;

function sessionFor(job: AgentJob): AgentSession {
  return {
    id: `omni:${job.jobId}`,
    harness: "omni",
    pid: 0,
    entrypoint: "app",
    name: `Compose · ${job.projectId}`,
    task: job.doing,
    cwd: "/",
    projectId: job.projectId,
    startedAt: job.startedAt,
    ...(job.endedAt === undefined ? {} : { lastActivityAt: job.endedAt }),
    link: "process-only",
    processPids: [],
    worktreeIds: [],
    totals: { cpuPercent: 0, rssMb: 0 },
    flags: [],
    activity: {
      ...(job.doing ? { latestPrompt: job.doing } : {}),
      turns: job.status === "running" ? 0 : 1,
    },
    job,
  };
}

// A model's text or an error message may span lines: the IPC contract is one bounded line.
function oneLine(value: string, max: number): string {
  const flat = value
    .replace(/[\r\n\u0000]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const text = flat || "—";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createAgentJobRunner(options: AgentJobRunnerOptions): AgentJobRunner {
  const jobs = new Map<string, MutableJob>();
  const now = options.now ?? Date.now;
  const getModels = options.getModels ?? ((connection) => listModels(connection, { readKey: options.readKey }));

  const start = async (
    request: Readonly<{ job: "compose"; projectId: string; grantHandle: string }>,
  ): Promise<AgentJobStartResponse> => {
    if ([...jobs.values()].some((entry) => entry.job.projectId === request.projectId && entry.job.status === "running"))
      throw new Error("A job is already running for this project.");
    const connection = await options.getConnection();
    if (!connection) return { status: "unavailable", reason: NO_CONNECTION_REASON };
    const projectGrant = options.registry.get(request.grantHandle);
    if (!projectGrant || projectGrant.subject.kind !== "project" || projectGrant.subject.id !== request.projectId)
      throw new Error("The project grant is invalid or expired.");
    const registry = await options.registry.listRegistry();
    if (registry.status !== "ready") throw new Error("The registry is unavailable.");
    const personal = activeWorkshop(registry.registry);
    if (!personal) throw new Error("A personal marketplace is required to compose skills.");
    const marketplaceHandle = await options.registry.getGrantForEntry({ kind: "source", id: personal.ref.id });
    if (!marketplaceHandle) throw new Error("The marketplace grant is unavailable.");
    const marketplaceGrant = options.registry.get(marketplaceHandle);
    if (!marketplaceGrant) throw new Error("The marketplace grant is invalid or expired.");
    const marketplace = await options.router.handle(
      "list_marketplace",
      {},
      { name: "omni-job", version: options.appVersion ?? "0.1.0" },
    );
    const packageId = ((marketplace as { packages?: readonly { id?: unknown }[] }).packages ?? [])[0]?.id;
    if (typeof packageId !== "string") throw new Error("The personal marketplace has no package.");
    const models = await getModels(connection);
    const route = resolve("agent", connection, models, await options.getFunctions?.());
    if (route.status !== "ready") return { status: "unavailable", reason: route.reason };
    const jobId = randomUUID();
    const job: AgentJob = {
      jobId,
      job: "compose",
      projectId: request.projectId,
      startedAt: now(),
      status: "running",
      doing: "Starting composition",
      turns: 0,
      toolCalls: 0,
      tokens: { input: 0, output: 0 },
      context: { estimate: 0, window: route.model.contextWindow },
      costUsd: 0,
      requestIds: [],
    };
    const grants: JobGrants = {
      projectId: request.projectId,
      projectRoot: projectGrant.root,
      marketplaceRoot: marketplaceGrant.root,
      sourceId: personal.ref.id,
      packageId,
    };
    const harness = createJobHarness({
      connection,
      model: route.model,
      readKey: options.readKey,
      router: options.router,
      grants,
      budget: options.budget,
      jobId,
      appVersion: options.appVersion,
      systemPrompt: composeJob.system,
      tools: composeJob.tools,
      writeBudget: composeJob.writeBudget,
      streamFn: options.streamFn,
    });
    const mutable: MutableJob = { job, harness };
    jobs.set(jobId, mutable);
    void (async () => {
      try {
        const input = await composeJob.input(request.projectId, {
          router: options.router,
          client: { name: "omni-job", version: options.appVersion ?? "0.1.0", sessionName: jobId },
          contextBudget: calculateContextBudget(route.model.contextWindow, maxTokensPerTurn(route.model)),
        });
        const result = await harness.run(input);
        mutable.job = {
          ...mutable.job,
          endedAt: now(),
          status: result.status,
          doing: oneLine(result.summary, 120),
          turns: result.turns,
          toolCalls: result.toolCalls,
          tokens: { input: result.inputTokens, output: result.outputTokens },
          context: { estimate: result.contextEstimate, window: result.contextWindow, peak: result.contextPeak },
          costUsd: result.costUsd,
          requestIds: result.requestIds,
          summary: oneLine(result.summary, 400),
          ...(result.reason ? { reason: oneLine(result.reason, 500) } : {}),
        };
      } catch (error: unknown) {
        mutable.job = {
          ...mutable.job,
          endedAt: now(),
          status: "failed",
          reason: oneLine(error instanceof Error ? error.message : "The job failed.", 500),
        };
      }
    })();
    return { jobId };
  };

  const stop = (jobId: string): Readonly<{ status: "stopping" | "missing" }> => {
    const found = jobs.get(jobId);
    if (!found || found.job.status !== "running") return { status: "missing" };
    found.harness?.stop();
    found.job = { ...found.job, status: "stopped", endedAt: now(), reason: "Stopped by the user." };
    return { status: "stopping" };
  };

  return {
    start,
    list: () => [...jobs.values()].map((entry) => entry.job),
    stop,
    activitySessions: () => [...jobs.values()].map((entry) => sessionFor(entry.job)),
  };
}
