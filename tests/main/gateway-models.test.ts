import { describe, expect, it, vi } from "vitest";

import { createConnection } from "../../src/main/inference/gateway/connection";
import { listModels, testConnection } from "../../src/main/inference/gateway/models";

describe("gateway model listing", () => {
  it("lists models from pi's built-in provider registry", async () => {
    const models = await listModels(createConnection("anthropic"));
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === "anthropic")).toBe(true);
  });

  it("maps an OpenAI-compatible /models response with zero pricing and unknown limits", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "local-model", name: "Local" }] }), { status: 200 }),
      );
    const models = await listModels(createConnection("ollama"), { fetch });
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/v1/models", expect.objectContaining({ method: "GET" }));
    expect(models[0]).toMatchObject({
      id: "local-model",
      api: "openai-completions",
      contextWindow: 0,
      maxTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("reports unreachable without making a priced call", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(testConnection(createConnection("ollama"), { fetch })).resolves.toEqual({
      status: "unreachable",
      reason: "No server answers at http://localhost:11434/v1.",
    });
    const denied = vi.fn().mockRejectedValue(new Error("HTTP 403 from /models"));
    await expect(testConnection(createConnection("ollama"), { fetch: denied })).resolves.toEqual({
      status: "unreachable",
      reason: "HTTP 403 from /models",
    });
  });

  it("reports key-missing before listing a key-required preset", async () => {
    const fetch = vi.fn();
    await expect(
      testConnection(createConnection("anthropic"), { fetch, readKey: async () => undefined }),
    ).resolves.toEqual({ status: "key-missing" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
