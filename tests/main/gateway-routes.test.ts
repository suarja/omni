import { describe, expect, it } from "vitest";

import { createConnection } from "../../src/main/inference/gateway/connection";
import { resolve } from "../../src/main/inference/gateway/routes";
import type { GatewayModel } from "../../src/main/inference/gateway/models";

const model = (id: string, provider = "openrouter"): GatewayModel => ({
  id,
  name: id,
  provider,
  api: "openai-completions",
  baseUrl: "http://localhost/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
  maxOutputTokens: 4_096,
  tools: true,
  structuredOutputs: true,
  free: false,
});

describe("gateway route resolver", () => {
  const remote = createConnection("openrouter");
  const local = createConnection("ollama");
  const models = [model("vendor/gpt-5-mini"), model("vendor/claude-sonnet-5"), model("vendor/llama3.2")];

  it("chooses the first listed model matching each task tier", () => {
    expect(resolve("explain", remote, models)).toEqual({ status: "ready", model: models[0] });
    expect(resolve("suggest-adapt", remote, models)).toEqual({ status: "ready", model: models[1] });
  });

  it("honors an explicit model route", () => {
    expect(
      resolve("explain", remote, models, {
        "suggest-adapt": "auto",
        explain: { modelId: models[2]!.id },
        summarize: "auto",
        compose: "auto",
      }),
    ).toEqual({ status: "ready", model: models[2] });
  });

  it("routes every task on any connection — the data policy is the budget's opt-in rule, not the resolver's", () => {
    expect(resolve("summarize", remote, models)).toEqual({ status: "ready", model: models[0] });
    expect(resolve("summarize", local, models)).toEqual({ status: "ready", model: models[0] });
  });

  it("returns deterministic reasons for no connection and no model", () => {
    expect(resolve("explain", undefined, models)).toEqual({
      status: "unavailable",
      reason: "Add a connection in Settings · AI.",
    });
    expect(resolve("explain", remote, [])).toEqual({ status: "unavailable", reason: "The connection has no models." });
  });

  it("requires tool calls and enough context for Auto", () => {
    const noTools = model("vendor/claude-sonnet-5");
    const smallWindow = { ...model("vendor/gpt-5"), contextWindow: 8_000 };
    expect(resolve("suggest-adapt", remote, [{ ...noTools, tools: false }, smallWindow])).toEqual({
      status: "ready",
      model: smallWindow,
    });
    expect(resolve("agent", remote, [smallWindow])).toEqual({
      status: "unavailable",
      reason: "the largest window is 8 k, the job needs 32 k",
    });
    expect(resolve("agent", remote, [{ ...smallWindow, tools: false }])).toEqual({
      status: "unavailable",
      reason: "no listed model supports tool calls",
    });
  });

  it("never chooses a free model for Auto but keeps it available manually", () => {
    const free = {
      ...model("vendor/gpt-5:free"),
      free: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(resolve("explain", remote, [free])).toEqual({
      status: "unavailable",
      reason: "no free model is eligible for Auto",
    });
    expect(
      resolve("explain", remote, [free], {
        "suggest-adapt": "auto",
        explain: { modelId: free.id },
        summarize: "auto",
        compose: "auto",
      }),
    ).toEqual({ status: "ready", model: free });
  });

  it("matches preference ids across dots and dashes", () => {
    const haiku = model("anthropic/claude-haiku-4.5");
    expect(resolve("explain", remote, [haiku])).toEqual({ status: "ready", model: haiku });
  });
});
