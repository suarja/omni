import { Agent, convertToLlm, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createModelsForConnection, type GatewayModel } from "../inference/gateway/models";
import type { Budget } from "../inference/budget";
import type { Connection } from "../../shared/ai-gateway-ipc";
import type { AgentClient, AgentRouter } from "../agent-gateway/server";
import { composeOutputSchema } from "./jobs/compose";
import { createJobTools, type JobGrants, type JobTool } from "./tools";
import {
  calculateContextBudget,
  contextExhaustionReason,
  estimateTokens,
  isContextExhausted,
  maxTokensPerTurn,
  pruneContext,
} from "./context-budget";

const MAX_TURNS = 40;
const MAX_DURATION_MS = 300_000;
export type JobHarnessOptions = Readonly<{
  connection: Connection;
  model: GatewayModel;
  readKey: () => Promise<string | undefined>;
  router: AgentRouter;
  grants: JobGrants;
  budget: Budget;
  jobId?: string;
  appVersion?: string;
  systemPrompt?: string;
  tools?: readonly string[];
  writeBudget?: number;
  streamFn?: StreamFn;
  now?: () => number;
}>;

export type JobHarnessResult = Readonly<{
  status: "done" | "stopped" | "failed";
  requestIds: readonly string[];
  summary: string;
  reason?: string;
  toolCalls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  contextEstimate: number;
  contextWindow: number;
  contextPeak: number;
}>;

export type JobHarness = Readonly<{
  agent: Agent;
  tools: readonly JobTool[];
  run(input: string): Promise<JobHarnessResult>;
  stop(): void;
}>;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "The agent job failed.";
  // Gateways reserve prompt + max_tokens in credits before answering: say so in one line.
  if (/billing_error|payment_required|\b402\b/u.test(message))
    return "The connection refused the call: insufficient credits for this prompt (add credits to the provider).";
  return message.slice(0, 500);
}

function summaryForTool(name: string): string {
  if (name === "read_file") return "Reading project conventions";
  if (name === "search") return "Searching observed project assets";
  if (name.includes("preview")) return "Preparing skill previews for Review";
  return `Reading ${name.replace(/^omni_/, "").replaceAll("_", " ")}`;
}

function usageFromMessage(message: unknown): Readonly<{ input: number; output: number; cost: number }> {
  if (typeof message !== "object" || message === null) return { input: 0, output: 0, cost: 0 };
  const usage = (message as { usage?: { input?: unknown; output?: unknown; cost?: { total?: unknown } } }).usage;
  return {
    input: typeof usage?.input === "number" ? usage.input : 0,
    output: typeof usage?.output === "number" ? usage.output : 0,
    cost: typeof usage?.cost?.total === "number" ? usage.cost.total : 0,
  };
}

function resultStatus(status: JobHarnessResult["status"], reason: string | undefined): "ok" | "failed" {
  return status === "done" && !reason ? "ok" : "failed";
}

export function createJobHarness(options: JobHarnessOptions): JobHarness {
  const jobId = options.jobId ?? "omni-job";
  const writeBudget = options.writeBudget ?? 1;
  const systemPrompt = options.systemPrompt ?? "You are a bounded Omni job. Use only the provided Omni tools.";
  const maxOutputTokens = maxTokensPerTurn(options.model);
  const contextBudget = calculateContextBudget(options.model.contextWindow, maxOutputTokens);
  const client: AgentClient = { name: "omni-job", version: options.appVersion ?? "0.1.0", sessionName: jobId };
  const tools = createJobTools({
    router: options.router,
    grants: options.grants,
    client,
    methods: options.tools ?? [
      "stack_profile",
      "list_project_assets",
      "skill_inventory",
      "list_marketplace",
      "catalog_search",
      "suggest",
      "read_file",
      "search",
      "preview_create_skill",
    ],
    readFileBudgetTokens: contextBudget,
  });
  const toolNames = new Set(tools.map((tool) => tool.name));
  let previewCount = 0;
  let toolCalls = 0;
  let turns = 0;
  let lastToolName = "";
  let doing = "Starting composition";
  let stopReason: string | undefined;
  let contextExhausted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requestIds: string[] = [];
  let usage = { input: 0, output: 0, cost: 0 };
  let contextEstimate = estimateTokens(systemPrompt);
  let contextPeak = contextEstimate;
  const defaultModels = createModelsForConnection(options.connection, [options.model]);
  const defaultStream = defaultModels.streamSimple.bind(defaultModels);
  const streamFn: StreamFn = async (model, context, streamOptions?: SimpleStreamOptions) => {
    try {
      const key = await options.readKey();
      const fn = options.streamFn ?? defaultStream;
      return await fn(model, context, {
        ...streamOptions,
        maxTokens: maxOutputTokens,
        ...(key ? { apiKey: key } : {}),
      });
    } catch (error: unknown) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: errorText(error),
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: message });
      return stream;
    }
  };
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: options.model as Model<Api>,
      thinkingLevel: "off",
      tools: tools as never,
      messages: [],
    },
    streamFn,
    convertToLlm,
    transformContext: async (messages) => {
      const transformed = pruneContext(messages, contextBudget, systemPrompt);
      contextEstimate = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(transformed));
      contextPeak = Math.max(contextPeak, contextEstimate);
      return [...transformed];
    },
    sessionId: jobId,
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall, args }) => {
      if (!toolNames.has(toolCall.name) || /(?:shell|bash|terminal|exec|command)/iu.test(toolCall.name))
        return { block: true, reason: "This tool is outside the job's allowed Omni subset.", terminate: true };
      if (toolCall.name.startsWith("omni_preview_")) {
        if (previewCount >= writeBudget)
          return { block: true, reason: "The job's preview budget is exhausted.", terminate: true };
        previewCount += 1;
        if (toolCall.name === "omni_preview_create_skill") {
          const value = args as Record<string, unknown>;
          if (value.sourceId !== options.grants.sourceId || value.packageId !== options.grants.packageId)
            return { block: true, reason: "The preview target is outside the job's grant.", terminate: true };
        }
      }
      if (
        (toolCall.name === "read_file" || toolCall.name === "search") &&
        !["project", "marketplace"].includes((args as Record<string, unknown>).root as string)
      )
        return { block: true, reason: "The read root is outside the job's grant.", terminate: true };
      return undefined;
    },
    shouldStopAfterTurn: async () => requestIds.length >= writeBudget,
  });
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "turn_start") turns += 1;
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      lastToolName = event.toolName;
      doing = summaryForTool(event.toolName);
    }
    if (event.type === "tool_execution_end") {
      const details = event.result?.details as { requestId?: unknown } | undefined;
      if (typeof details?.requestId === "string" && !requestIds.includes(details.requestId))
        requestIds.push(details.requestId);
    }
    if (
      event.type === "message_end" &&
      typeof event.message === "object" &&
      event.message !== null &&
      "role" in event.message &&
      event.message.role === "assistant"
    ) {
      if (isContextExhausted(event.message)) {
        contextExhausted = true;
        stopReason = contextExhaustionReason(contextEstimate, options.model.contextWindow, turns);
        agent.abort();
      }
      const current = usageFromMessage(event.message);
      usage = {
        input: usage.input + current.input,
        output: usage.output + current.output,
        cost: usage.cost + current.cost,
      };
    }
    if (event.type === "turn_end") {
      doing = lastToolName ? summaryForTool(lastToolName) : "Planning the composition";
      if (turns >= MAX_TURNS) {
        stopReason = "The job stopped after 40 turns.";
        agent.abort();
      }
    }
  });

  const stop = (): void => {
    stopReason = "Stopped by the user.";
    agent.abort();
  };

  const run = async (input: string): Promise<JobHarnessResult> => {
    const started = (options.now ?? Date.now)();
    timer = setTimeout(() => {
      stopReason = "The job stopped after 300 seconds.";
      agent.abort();
    }, MAX_DURATION_MS);
    try {
      await agent.prompt(input);
      await agent.waitForIdle();
    } catch (error: unknown) {
      if (isContextExhausted({ errorMessage: errorText(error) })) {
        contextExhausted = true;
        stopReason = contextExhaustionReason(contextEstimate, options.model.contextWindow, turns);
      } else stopReason ??= errorText(error);
    } finally {
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
    const failed = Boolean(agent.state.errorMessage) || (!stopReason && turns === 0);
    const status: JobHarnessResult["status"] = contextExhausted
      ? "failed"
      : stopReason?.startsWith("Stopped") || stopReason?.includes("stopped after")
        ? "stopped"
        : failed
          ? "failed"
          : "done";
    const summary = requestIds.length
      ? `Proposed ${requestIds.length} skill${requestIds.length === 1 ? "" : "s"} in Review.`
      : doing.slice(0, 400);
    const reason =
      status === "failed"
        ? contextExhausted
          ? stopReason
          : errorText(new Error(stopReason ?? agent.state.errorMessage ?? "The model failed."))
        : stopReason;
    if (options.budget.recordAgentUsage)
      await options.budget.recordAgentUsage({
        connectionId: options.connection.preset,
        modelId: options.model.id,
        inputTokens: usage.input,
        outputTokens: usage.output,
        costUsd: usage.cost,
        status: resultStatus(status, reason),
      });
    void started;
    return {
      status,
      requestIds,
      summary,
      ...(reason ? { reason } : {}),
      toolCalls,
      turns,
      inputTokens: usage.input,
      outputTokens: usage.output,
      costUsd: usage.cost,
      contextEstimate,
      contextWindow: options.model.contextWindow,
      contextPeak,
    };
  };

  return { agent, tools, run, stop };
}
