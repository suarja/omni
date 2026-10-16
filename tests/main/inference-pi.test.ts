import anthropicExplain from "../fixtures/inference/anthropic-explain.json";
import anthropicSuggest from "../fixtures/inference/anthropic-suggest-adapt.json";
import anthropicSummarize from "../fixtures/inference/anthropic-summarize.json";
import ollamaExplain from "../fixtures/inference/ollama-explain.json";
import ollamaSuggest from "../fixtures/inference/ollama-suggest-adapt.json";
import ollamaSummarize from "../fixtures/inference/ollama-summarize.json";
import openrouterExplain from "../fixtures/inference/openrouter-explain.json";
import openrouterSuggest from "../fixtures/inference/openrouter-suggest-adapt.json";
import openrouterSummarize from "../fixtures/inference/openrouter-summarize.json";
import vercelExplain from "../fixtures/inference/vercel-ai-gateway-explain.json";
import vercelSuggest from "../fixtures/inference/vercel-ai-gateway-suggest-adapt.json";
import vercelSummarize from "../fixtures/inference/vercel-ai-gateway-summarize.json";
import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

import { createConnection } from "../../src/main/inference/gateway/connection";
import { buildPiRequest, createPiProvider } from "../../src/main/inference/providers/pi";
import type { InferenceCall } from "../../src/main/inference/provider";
import { explainTask } from "../../src/main/inference/tasks/explain";
import { summarizeTask } from "../../src/main/inference/tasks/summarize";
import { suggestAdaptTask } from "../../src/main/inference/tasks/suggest-adapt";
import type { TaskId } from "../../src/shared/inference-ipc";

const model = (id: string, provider: string): Model<Api> => ({
  id,
  name: id,
  api: "openai-completions",
  provider,
  baseUrl: "http://localhost/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 100,
});
const message = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  api: "openai-completions",
  provider: "openrouter",
  model: "model-1",
  timestamp: 0,
  content: [
    {
      type: "toolCall",
      id: "call-1",
      name: "explain",
      arguments: { explanation: "Keep the right version.", keep: "right" },
    },
  ],
  usage: {
    input: 12,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 19,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  },
  stopReason: "toolUse",
  ...overrides,
});
const call = (connection = createConnection("openrouter")): InferenceCall<unknown> => ({
  task: "explain",
  system: "System instruction",
  input: "User content",
  schema: explainTask.schema,
  maxOutputTokens: 100,
  connection,
  model: model("model-1", connection.preset),
});

describe("pi inference provider", () => {
  it("validates one tool call and returns pi usage and cost", async () => {
    const completeImpl = vi.fn().mockResolvedValue(message());
    const provider = createPiProvider({
      connection: createConnection("openrouter"),
      readKey: async () => "secret",
      completeImpl,
    });
    await expect(provider.complete(call())).resolves.toEqual({
      status: "ok",
      value: { explanation: "Keep the right version.", keep: "right" },
      usage: { inputTokens: 12, outputTokens: 7, costUsd: 0.03, connectionId: "openrouter", modelId: "model-1" },
    });
    expect(completeImpl).toHaveBeenCalledWith(
      expect.objectContaining({ id: "model-1" }),
      expect.anything(),
      expect.objectContaining({ apiKey: "secret", signal: expect.any(AbortSignal) }),
    );
  });

  it("reads the key at call time, passes it only in options, and never puts it in context", async () => {
    let key = "first-secret";
    const completeImpl = vi.fn(
      async (_model: Model<Api>, context: unknown, options: Readonly<Record<string, unknown>>) => {
        expect(JSON.stringify(context)).not.toContain(key);
        expect(options.apiKey).toBe(key);
        return message();
      },
    );
    const provider = createPiProvider({
      connection: createConnection("openrouter"),
      readKey: async () => key,
      completeImpl,
    });
    await provider.complete(call());
    key = "second-secret";
    await provider.complete(call());
    expect(completeImpl).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ apiKey: "first-secret" }),
    );
    expect(completeImpl).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ apiKey: "second-secret" }),
    );
  });

  it("turns rejected keys into refused and never echoes the key in provider errors", async () => {
    const key = "secret-api-key";
    const refused = createPiProvider({
      connection: createConnection("anthropic"),
      readKey: async () => key,
      completeImpl: vi.fn().mockRejectedValue(new Error("401 invalid api key secret-api-key")),
    });
    await expect(refused.complete(call(createConnection("anthropic")))).resolves.toEqual({
      status: "refused",
      reason: "The key was rejected by Anthropic.",
    });
    const failed = createPiProvider({
      connection: createConnection("anthropic"),
      readKey: async () => key,
      completeImpl: vi.fn().mockRejectedValue(new Error("upstream exploded secret-api-key")),
    });
    const result = await failed.complete(call(createConnection("anthropic")));
    expect(result).toEqual({ status: "failed", reason: "upstream exploded [redacted]" });
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("throws a retryable error on 429 and 5xx so the budget backs off, key redacted", async () => {
    const key = "secret-api-key";
    const limited = createPiProvider({
      connection: createConnection("openrouter"),
      readKey: async () => key,
      completeImpl: vi
        .fn()
        .mockRejectedValue(new Error('429 {"message":"Provider returned error secret-api-key","code":429}')),
    });
    const thrown = await limited.complete(call(createConnection("openrouter"))).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ status: 429, retryable: true });
    expect(String((thrown as Error).message)).not.toContain(key);
    const overloaded = createPiProvider({
      connection: createConnection("openrouter"),
      readKey: async () => key,
      completeImpl: vi.fn().mockRejectedValue(new Error("Upstream error from Nvidia: Service temporarily overloaded")),
    });
    await expect(overloaded.complete(call(createConnection("openrouter")))).rejects.toMatchObject({ retryable: true });
  });

  it("reports no tool calls and aborts as honest failures", async () => {
    const noTool = createPiProvider({
      connection: createConnection("openrouter"),
      readKey: async () => undefined,
      completeImpl: vi
        .fn()
        .mockResolvedValue(message({ content: [{ type: "text", text: "plain text" }], stopReason: "stop" })),
    });
    await expect(noTool.complete(call())).resolves.toEqual({
      status: "invalid-output",
      reason: "The provider returned no single structured tool result.",
    });
    const aborted = createPiProvider({
      connection: createConnection("openrouter"),
      readKey: async () => undefined,
      completeImpl: vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })),
    });
    await expect(aborted.complete(call())).resolves.toEqual({ status: "failed", reason: "The request was aborted." });
  });

  it.each([
    ["anthropic", "suggest-adapt", anthropicSuggest],
    ["anthropic", "explain", anthropicExplain],
    ["anthropic", "summarize", anthropicSummarize],
    ["openrouter", "suggest-adapt", openrouterSuggest],
    ["openrouter", "explain", openrouterExplain],
    ["openrouter", "summarize", openrouterSummarize],
    ["vercel-ai-gateway", "suggest-adapt", vercelSuggest],
    ["vercel-ai-gateway", "explain", vercelExplain],
    ["vercel-ai-gateway", "summarize", vercelSummarize],
    ["ollama", "suggest-adapt", ollamaSuggest],
    ["ollama", "explain", ollamaExplain],
    ["ollama", "summarize", ollamaSummarize],
  ] as const)("matches the readable %s %s request fixture without a key", (preset, taskId, fixture) => {
    const task = taskId === "suggest-adapt" ? suggestAdaptTask : taskId === "explain" ? explainTask : summarizeTask;
    const request = buildPiRequest({
      task: taskId as TaskId,
      system: task.system,
      input: "fixture input",
      schema: task.schema,
      maxOutputTokens: 100,
      connection: createConnection(preset),
      model: model(fixture.modelId, fixture.provider),
    });
    expect(request).toEqual(fixture);
  });
});
