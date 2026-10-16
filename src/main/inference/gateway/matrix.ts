import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";

import type { Connection } from "../../../shared/ai-gateway-ipc";
import type { GatewayModel } from "./models";

export type ModelFacts = Readonly<{
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  tools: boolean | "unknown";
  structuredOutputs: boolean | "unknown";
  pricing: Readonly<{ inputPerMillion: number; outputPerMillion: number }> | "unknown";
  free: boolean;
  source: "registry" | "openrouter" | "listing";
}>;

export type OpenRouterListing = Readonly<{
  id: string;
  contextWindow: number;
  maxOutputTokens?: number;
  pricing: Readonly<{ inputPerMillion: number; outputPerMillion: number }> | "unknown";
  tools: boolean;
  structuredOutputs: boolean;
}>;
type MatrixCache = Readonly<{ fetchedAt: number; models: readonly OpenRouterListing[] }>;
export type ModelFactsOptions = Readonly<{
  fetch?: typeof fetch;
  userDataPath?: string;
  cachePath?: string;
  now?: () => number;
}>;

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 5_000;
const openRouterSession = new Map<string, Promise<readonly OpenRouterListing[] | undefined>>();

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} is invalid.`);
  return value;
}

// OpenRouter prices are strings in USD per token; routers such as `openrouter/auto` publish
// `-1` (price decided per request) — that is "unknown", not an error.
function price(value: unknown, label: string): number | "unknown" {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const parsed = Number(value) * 1_000_000;
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid.`);
  return parsed < 0 ? "unknown" : parsed;
}

function listing(value: unknown): OpenRouterListing {
  const item = record(value, "OpenRouter model");
  const pricing = record(item.pricing, "OpenRouter model pricing");
  const supported = item.supported_parameters;
  if (!Array.isArray(supported) || !supported.every((entry) => typeof entry === "string"))
    throw new Error("OpenRouter model supported parameters are invalid.");
  const topProvider =
    item.top_provider === undefined ? undefined : record(item.top_provider, "OpenRouter top provider");
  // `null` when the router decides per request: no bound known.
  const maxOutputTokens =
    topProvider?.max_completion_tokens === undefined || topProvider?.max_completion_tokens === null
      ? undefined
      : positiveNumber(topProvider.max_completion_tokens, "OpenRouter model max completion tokens");
  if (typeof item.id !== "string" || item.id.trim() === "") throw new Error("OpenRouter model id is invalid.");
  return {
    id: item.id,
    contextWindow: positiveNumber(item.context_length, "OpenRouter model context length"),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    pricing: listingPricing(
      price(pricing.prompt, "OpenRouter prompt price"),
      price(pricing.completion, "OpenRouter completion price"),
    ),
    tools: supported.includes("tools"),
    structuredOutputs: supported.includes("structured_outputs") || supported.includes("response_format"),
  };
}

function listingPricing(input: number | "unknown", output: number | "unknown"): OpenRouterListing["pricing"] {
  return input === "unknown" || output === "unknown" ? "unknown" : { inputPerMillion: input, outputPerMillion: output };
}

/**
 * One malformed entry never hides the other 440: it is skipped and counted, so a listing that
 * changed shape still yields every model that parses (an empty result means the shape broke).
 */
export function parseOpenRouterListings(value: unknown): readonly OpenRouterListing[] {
  const body = record(value, "OpenRouter model listing");
  if (!Array.isArray(body.data)) throw new Error("OpenRouter model listing data must be an array.");
  const parsed = body.data.flatMap((item) => {
    try {
      return [listing(item)];
    } catch {
      return [];
    }
  });
  if (body.data.length > 0 && parsed.length === 0) throw new Error("OpenRouter model listing has no readable model.");
  return parsed;
}

function cacheFile(options: ModelFactsOptions): string | undefined {
  if (options.cachePath) return options.cachePath;
  return options.userDataPath ? join(resolve(options.userDataPath), "omni", "model-facts.json") : undefined;
}

function parseCache(value: unknown): MatrixCache {
  const cache = record(value, "Model facts cache");
  if (typeof cache.fetchedAt !== "number" || !Number.isFinite(cache.fetchedAt) || !Array.isArray(cache.models))
    throw new Error("Model facts cache is invalid.");
  return { fetchedAt: cache.fetchedAt, models: cache.models.map(listing) };
}

async function readCache(path: string | undefined): Promise<MatrixCache | undefined> {
  if (!path) return undefined;
  try {
    return parseCache(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

async function fetchListings(fetchImpl: typeof fetch): Promise<readonly OpenRouterListing[]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      fetchImpl(OPENROUTER_MODELS_URL, { method: "GET", signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("OpenRouter model listing timed out."));
        }, FETCH_TIMEOUT_MS);
      }),
    ]);
    if (!response.ok) throw new Error(`OpenRouter model listing returned status ${response.status}.`);
    return parseOpenRouterListings(await response.json());
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function openRouterListings(options: ModelFactsOptions): Promise<readonly OpenRouterListing[] | undefined> {
  const path = cacheFile(options);
  const key = path ?? "session";
  const existing = openRouterSession.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const now = (options.now ?? Date.now)();
    const cached = await readCache(path);
    if (cached && now - cached.fetchedAt <= CACHE_MAX_AGE_MS) return cached.models;
    try {
      const models = await fetchListings(options.fetch ?? globalThis.fetch);
      if (path) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ fetchedAt: now, models }), "utf8");
      }
      return models;
    } catch {
      return cached?.models;
    }
  })();
  openRouterSession.set(key, promise);
  return promise;
}

export function clearModelFactsCache(): void {
  openRouterSession.clear();
}

function registryCapability(model: GatewayModel, key: "tools" | "structuredOutputs"): boolean | "unknown" {
  const value = (model as GatewayModel & Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : "unknown";
}

function registryFacts(model: GatewayModel, source: ModelFacts["source"] = "registry"): ModelFacts {
  const pricing: ModelFacts["pricing"] =
    model.cost.input < 0 || model.cost.output < 0
      ? "unknown"
      : { inputPerMillion: model.cost.input, outputPerMillion: model.cost.output };
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    tools: registryCapability(model, "tools"),
    structuredOutputs: registryCapability(model, "structuredOutputs"),
    pricing,
    free:
      model.id.endsWith(":free") ||
      (pricing !== "unknown" && pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0),
    source,
  };
}

function modelFromFacts(model: GatewayModel, facts: ModelFacts): GatewayModel {
  return {
    ...model,
    contextWindow: facts.contextWindow,
    maxTokens: facts.maxOutputTokens,
    tools: facts.tools,
    structuredOutputs: facts.structuredOutputs,
    maxOutputTokens: facts.maxOutputTokens,
    free: facts.free,
    source: facts.source,
    ...(facts.pricing === "unknown"
      ? {}
      : {
          cost: {
            ...model.cost,
            input: facts.pricing.inputPerMillion,
            output: facts.pricing.outputPerMillion,
          },
        }),
  };
}

function listingModel(connection: Connection, item: OpenRouterListing): GatewayModel {
  return {
    id: item.id,
    name: item.id,
    api: "openai-completions",
    provider: connection.preset,
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      // -1 keeps "unknown" visible downstream (`registryFacts` maps a negative cost to "unknown").
      input: item.pricing === "unknown" ? -1 : item.pricing.inputPerMillion,
      output: item.pricing === "unknown" ? -1 : item.pricing.outputPerMillion,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: item.contextWindow,
    maxTokens: item.maxOutputTokens ?? 4_096,
  };
}

function factsForListing(item: OpenRouterListing, registry: GatewayModel | undefined): ModelFacts {
  const base = registry
    ? registryFacts(registry)
    : registryFacts(listingModel({ preset: "openrouter", displayName: "OpenRouter" }, item));
  return {
    ...base,
    id: item.id,
    contextWindow: item.contextWindow,
    maxOutputTokens: item.maxOutputTokens ?? base.maxOutputTokens,
    tools: item.tools,
    structuredOutputs: item.structuredOutputs,
    pricing: item.pricing,
    free:
      item.id.endsWith(":free") ||
      (item.pricing !== "unknown" && item.pricing.inputPerMillion === 0 && item.pricing.outputPerMillion === 0),
    source: "openrouter",
  };
}

export async function listGatewayModels(
  connection: Connection,
  registryModels: readonly GatewayModel[],
  options: ModelFactsOptions = {},
): Promise<readonly GatewayModel[]> {
  if (connection.preset !== "openrouter") {
    if (connection.preset === "ollama" || connection.preset === "lmstudio" || connection.preset === "custom") {
      return registryModels.map((model) =>
        modelFromFacts(model, {
          ...registryFacts(model, "listing"),
          contextWindow: 0,
          maxOutputTokens: model.maxTokens,
          tools: "unknown",
          structuredOutputs: "unknown",
          pricing: { inputPerMillion: 0, outputPerMillion: 0 },
          free: true,
        }),
      );
    }
    return registryModels.map((model) => modelFromFacts(model, registryFacts(model)));
  }
  const listings = await openRouterListings(options);
  const byId = new Map(registryModels.map((model) => [model.id, model]));
  const merged = registryModels.map((model) => {
    const item = listings?.find((candidate) => candidate.id === model.id);
    return modelFromFacts(model, item ? factsForListing(item, model) : registryFacts(model));
  });
  for (const item of listings ?? []) {
    if (byId.has(item.id)) continue;
    merged.push(modelFromFacts(listingModel(connection, item), factsForListing(item, undefined)));
  }
  return merged;
}

export function factsFromModel(model: GatewayModel): ModelFacts {
  return {
    ...registryFacts(model),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens ?? model.maxTokens,
    tools: model.tools ?? "unknown",
    structuredOutputs: model.structuredOutputs ?? "unknown",
    free: model.free ?? (model.id.endsWith(":free") || (model.cost.input === 0 && model.cost.output === 0)),
    source: model.source ?? "registry",
  };
}
