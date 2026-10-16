import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnection } from "../../src/main/inference/gateway/connection";
import {
  clearModelFactsCache,
  listGatewayModels,
  parseOpenRouterListings,
} from "../../src/main/inference/gateway/matrix";
import { listModels } from "../../src/main/inference/gateway/models";

const listing = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  context_length: 262_144,
  pricing: { prompt: "0", completion: "0" },
  supported_parameters: ["tools", "structured_outputs"],
  top_provider: { max_completion_tokens: 8_192 },
  ...overrides,
});

describe("gateway model matrix", () => {
  afterEach(() => clearModelFactsCache());

  it("parses the public OpenRouter model shape and derives capabilities", () => {
    expect(parseOpenRouterListings({ data: [listing("vendor/model:free")] })).toEqual([
      {
        id: "vendor/model:free",
        contextWindow: 262_144,
        maxOutputTokens: 8_192,
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
        tools: true,
        structuredOutputs: true,
      },
    ]);
  });

  it("merges OpenRouter facts by id, keeps the registry name, and detects free models", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-matrix-"));
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            listing("anthropic/claude-sonnet-5", {
              context_length: 262_144,
              pricing: { prompt: "0.000003", completion: "0.000015" },
            }),
            listing("vendor/free:free"),
          ],
        }),
      ),
    );
    const models = await listModels(createConnection("openrouter"), { fetch, userDataPath: root });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(models.find((model) => model.id === "anthropic/claude-sonnet-5")).toMatchObject({
      name: expect.stringContaining("Claude"),
      contextWindow: 262_144,
      maxOutputTokens: 8_192,
      tools: true,
      structuredOutputs: true,
      cost: { input: 3, output: 15 },
      free: false,
      source: "openrouter",
    });
    expect(models.find((model) => model.id === "vendor/free:free")).toMatchObject({ free: true, tools: true });
  });

  it("uses a fresh disk cache and falls back to an old cache when offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-matrix-cache-"));
    const cachePath = join(root, "omni", "model-facts.json");
    const cached = { fetchedAt: 1_000, models: [listing("cached/model")] };
    await mkdir(join(root, "omni"), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cached), "utf8");
    const freshFetch = vi.fn().mockRejectedValue(new Error("offline"));
    const fresh = await listGatewayModels(createConnection("openrouter"), [], {
      cachePath,
      fetch: freshFetch,
      now: () => 2_000,
    });
    expect(fresh).toHaveLength(1);
    expect(freshFetch).not.toHaveBeenCalled();

    clearModelFactsCache();
    const offlineFetch = vi.fn().mockRejectedValue(new Error("offline"));
    const offline = await listGatewayModels(createConnection("openrouter"), [], {
      cachePath,
      fetch: offlineFetch,
      now: () => 24 * 60 * 60 * 1_000 + 2_000,
    });
    expect(offline).toHaveLength(1);
    expect(offlineFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual(cached);
  });

  it("refreshes a stale cache once and writes the new fetchedAt", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-matrix-refresh-"));
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [listing("fresh/model")] })));
    const models = await listGatewayModels(createConnection("openrouter"), [], {
      userDataPath: root,
      fetch,
      now: () => 100_000_000,
    });
    expect(models[0]?.id).toBe("fresh/model");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(root, "omni", "model-facts.json"), "utf8"))).toMatchObject({
      fetchedAt: 100_000_000,
    });

    await listGatewayModels(createConnection("openrouter"), [], { userDataPath: root, fetch, now: () => 100_000_001 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a router's -1 price as unknown instead of rejecting the listing", () => {
    const [router] = parseOpenRouterListings({
      data: [
        {
          id: "openrouter/auto",
          context_length: 200000,
          pricing: { prompt: "-1", completion: "-1" },
          supported_parameters: ["tools"],
        },
      ],
    });
    expect(router).toMatchObject({ id: "openrouter/auto", pricing: "unknown", tools: true });
  });

  it("skips a malformed entry instead of dropping the whole listing", () => {
    const parsed = parseOpenRouterListings({
      data: [
        { id: "broken", context_length: "n/a", pricing: {}, supported_parameters: [] },
        {
          id: "openrouter/router",
          context_length: 200000,
          pricing: { prompt: "-1", completion: "-1" },
          supported_parameters: ["tools"],
          top_provider: { max_completion_tokens: null },
        },
        listing("vendor/model:free"),
      ],
    });
    expect(parsed.map((model) => model.id)).toEqual(["openrouter/router", "vendor/model:free"]);
    expect(() => parseOpenRouterListings({ data: [{ id: "broken", pricing: {} }] })).toThrow(/no readable model/);
  });
});
