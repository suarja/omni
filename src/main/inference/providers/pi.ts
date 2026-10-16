import { type Api, type AssistantMessage, type Context, type Model, type Tool } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

import type { Connection } from "../../../shared/ai-gateway-ipc";
import { createModelsForConnection, type GatewayModel } from "../gateway/models";
import type { InferenceCall, InferenceProvider, InferenceResult, TaskId } from "../provider";
import { explainTask } from "../tasks/explain";
import { suggestAdaptTask } from "../tasks/suggest-adapt";
import { summarizeTask } from "../tasks/summarize";
import { zodToTypeBox } from "./typebox-schema";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_FAILURE_MESSAGE_CHARS = 200;
const TASK_SCHEMAS: Record<TaskId, TSchema> = {
  "suggest-adapt": zodToTypeBox(suggestAdaptTask.schema),
  explain: zodToTypeBox(explainTask.schema),
  summarize: zodToTypeBox(summarizeTask.schema),
};
const TASK_TOOLS: Record<TaskId, Tool> = Object.fromEntries(
  (Object.keys(TASK_SCHEMAS) as TaskId[]).map((task) => [
    task,
    {
      name: task.replace(/-/g, "_"),
      description: "Return the structured output for this task and nothing else.",
      parameters: TASK_SCHEMAS[task],
      constrainedSampling: { type: "json_schema", strict: "prefer" },
    },
  ]),
) as Record<TaskId, Tool>;

export type PiComplete = (
  model: Model<Api>,
  context: Context,
  options: Readonly<Record<string, unknown>>,
) => Promise<AssistantMessage>;
export type CreatePiProviderOptions = Readonly<{
  connection: Connection;
  readKey: () => Promise<string | undefined>;
  models?: readonly GatewayModel[];
  completeImpl?: PiComplete;
}>;

function truncate(message: string, secret?: string): string {
  const redacted = secret && secret.length > 0 ? message.split(secret).join("[redacted]") : message;
  const clean = redacted.replace(/[\r\n]/g, " ");
  return clean.length <= MAX_FAILURE_MESSAGE_CHARS ? clean : `${clean.slice(0, MAX_FAILURE_MESSAGE_CHARS - 1)}…`;
}
function rejected(message: string): boolean {
  return /(?:\b401\b|unauthori[sz]ed|invalid.{0,20}(?:key|token)|authentication.{0,20}fail|api key.{0,20}reject)/i.test(
    message,
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The provider request failed.";
}

// Rate limits and upstream overloads come back as a message that starts with the status
// (pi: "429 {…}", "503 …", "529 …"): the budget retries those with backoff, nothing else.
function retryableStatus(message: string): number | undefined {
  const match = /^(429|5\d\d)\b/u.exec(message.trim());
  if (match) return Number(match[1]);
  return /rate-limited|rate limit|temporarily overloaded|overloaded_error/iu.test(message) ? 429 : undefined;
}

function throwIfRetryable(message: string, key?: string): void {
  const status = retryableStatus(message);
  if (status === undefined) return;
  const error = new Error(truncate(message, key)) as Error & { status: number; retryable: boolean };
  error.status = status;
  error.retryable = true;
  throw error;
}
function resultFromMessage<T>(
  message: AssistantMessage,
  task: TaskId,
  connection: Connection,
  key?: string,
): InferenceResult<T> {
  const messageError = message.errorMessage ?? "The provider request failed.";
  if (message.stopReason === "aborted") return { status: "failed", reason: "The request was aborted." };
  if (message.stopReason === "error") {
    if (rejected(messageError))
      return { status: "refused", reason: `The key was rejected by ${connection.displayName}.` };
    throwIfRetryable(messageError, key);
    return { status: "failed", reason: truncate(messageError, key) };
  }
  const calls = message.content.filter(
    (block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall",
  );
  if (message.stopReason !== "toolUse" || calls.length !== 1 || calls[0]!.name !== task.replace(/-/g, "_"))
    return { status: "invalid-output", reason: "The provider returned no single structured tool result." };
  const value = calls[0]!.arguments as T;
  const taskSchema =
    task === "suggest-adapt" ? suggestAdaptTask.schema : task === "explain" ? explainTask.schema : summarizeTask.schema;
  const parsed = taskSchema.safeParse(value);
  if (!parsed.success) return { status: "invalid-output", reason: "The tool result did not match the task schema." };
  return {
    status: "ok",
    value: parsed.data as T,
    usage: {
      // pi splits cached prompt tokens out of `input`; the usage line counts what was sent.
      inputTokens: message.usage.input + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0),
      outputTokens: message.usage.output,
      costUsd: message.usage.cost.total,
      connectionId: connection.preset,
      modelId: message.model,
    },
  };
}

export function createPiProvider(options: CreatePiProviderOptions): InferenceProvider {
  const completeImpl =
    options.completeImpl ??
    (async (model, context, requestOptions) =>
      createModelsForConnection(options.connection, options.models).complete(model, context, requestOptions));
  const complete = async <T>(call: InferenceCall<T>): Promise<InferenceResult<T>> => {
    if (!call.model) return { status: "unavailable", reason: "No model is selected for this function." };
    const key = await options.readKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const context: Context = {
      systemPrompt: call.system,
      messages: [{ role: "user", content: call.input, timestamp: 0 }],
      tools: [TASK_TOOLS[call.task]],
    };
    try {
      const message = await completeImpl(call.model as Model<Api>, context, {
        ...(key ? { apiKey: key } : {}),
        maxTokens: call.maxOutputTokens,
        signal: controller.signal,
      });
      return resultFromMessage<T>(message, call.task, options.connection, key);
    } catch (error: unknown) {
      if ((error as { retryable?: unknown }).retryable === true) throw error;
      const message = errorMessage(error);
      if (rejected(message))
        return { status: "refused", reason: `The key was rejected by ${options.connection.displayName}.` };
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
        return { status: "failed", reason: "The request was aborted." };
      throwIfRetryable(message, key);
      return { status: "failed", reason: truncate(message, key) };
    } finally {
      clearTimeout(timeout);
    }
  };
  return {
    id: "pi",
    scope: options.connection.preset === "ollama" || options.connection.preset === "lmstudio" ? "local" : "remote",
    capabilities: { maxInputChars: 120_000, structuredOutput: true, streaming: false },
    complete,
  };
}

export function buildPiRequest(call: InferenceCall<unknown>): Readonly<{
  modelId: string;
  provider: string;
  system: string;
  userContent: string;
  toolSchema: Readonly<Record<string, unknown>>;
}> {
  if (!call.model) throw new Error("No model is selected for this function.");
  return {
    modelId: call.model.id,
    provider: call.model.provider,
    system: call.system,
    userContent: call.input,
    toolSchema: TASK_TOOLS[call.task].parameters as Readonly<Record<string, unknown>>,
  };
}
