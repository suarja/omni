import { createModels, createProvider, type Api, type Model, type Models, type Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import type { Connection } from "../../../shared/ai-gateway-ipc";
import { listGatewayModels } from "./matrix";
import { presetFor } from "./presets";

export type GatewayModel = Model<Api> &
  Partial<{
    tools: import("./matrix").ModelFacts["tools"];
    structuredOutputs: import("./matrix").ModelFacts["structuredOutputs"];
    free: boolean;
    maxOutputTokens: number;
    source: import("./matrix").ModelFacts["source"];
  }>;
export type ModelsFetch = typeof globalThis.fetch;

const EMPTY_AUTH = { apiKey: { name: "Omni", resolve: async () => ({ auth: {} }) } } as const;

function withoutAmbientAuth(provider: Provider): Provider {
  return { ...provider, auth: EMPTY_AUTH };
}

function builtinProvider(preset: Connection["preset"]): Provider | undefined {
  if (preset === "anthropic") return withoutAmbientAuth(anthropicProvider());
  if (preset === "openai") return withoutAmbientAuth(openaiProvider());
  if (preset === "openrouter") return withoutAmbientAuth(openrouterProvider());
  if (preset === "vercel-ai-gateway") return withoutAmbientAuth(vercelAIGatewayProvider());
  if (preset === "groq") return withoutAmbientAuth(groqProvider());
  if (preset === "mistral") return withoutAmbientAuth(mistralProvider());
  return undefined;
}

function openAiModel(connection: Connection, id: string, name?: string): GatewayModel {
  return {
    id,
    name: name ?? id,
    api: "openai-completions",
    provider: connection.preset,
    baseUrl: connection.baseUrl ?? presetFor(connection.preset).openAiCompatible?.defaultBaseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

export function createModelsForConnection(connection: Connection, models: readonly GatewayModel[] = []): Models {
  const collection = createModels();
  const builtin = builtinProvider(connection.preset);
  if (builtin) collection.setProvider(builtin);
  else {
    const modelProvider = createProvider({
      id: connection.preset,
      name: connection.displayName,
      baseUrl: connection.baseUrl,
      auth: EMPTY_AUTH,
      models,
      api: openAICompletionsApi(),
    });
    collection.setProvider(modelProvider);
  }
  return collection;
}

export type ListModelsOptions = Readonly<{
  fetch?: ModelsFetch;
  readKey?: () => Promise<string | undefined>;
  userDataPath?: string;
  cachePath?: string;
  now?: () => number;
}>;

async function fetchCompatibleModels(
  connection: Connection,
  options: ListModelsOptions,
): Promise<readonly GatewayModel[]> {
  const baseUrl = connection.baseUrl ?? presetFor(connection.preset).openAiCompatible?.defaultBaseUrl;
  if (!baseUrl) throw new Error("A custom OpenAI-compatible connection needs a base URL.");
  const key = await options.readKey?.();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      signal: controller.signal,
      ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    });
    if (!response.ok) throw new Error(`Model listing returned status ${response.status}.`);
    const body = (await response.json()) as unknown;
    const data =
      typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: readonly unknown[] }).data
        : [];
    return data.flatMap((item) => {
      if (typeof item !== "object" || item === null || typeof (item as { id?: unknown }).id !== "string") return [];
      const candidate = item as { id: string; name?: unknown };
      return [openAiModel(connection, candidate.id, typeof candidate.name === "string" ? candidate.name : undefined)];
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function listModels(
  connection: Connection,
  options: ListModelsOptions = {},
): Promise<readonly GatewayModel[]> {
  const registryModels = presetFor(connection.preset).openAiCompatible
    ? await fetchCompatibleModels(connection, options)
    : (createModelsForConnection(connection).getModels(connection.preset) as readonly GatewayModel[]);
  return listGatewayModels(connection, registryModels, options);
}

/** Node's fetch says "fetch failed" for a closed port: say where nothing answered instead. */
export function unreachableReason(error: unknown, connection: Connection): string {
  const message = error instanceof Error ? error.message : "";
  return !message || /fetch failed|ECONNREFUSED/i.test(message)
    ? `No server answers at ${connection.baseUrl ?? presetFor(connection.preset).displayName}.`
    : message.slice(0, 500);
}

export type ConnectionTestResult =
  | Readonly<{ status: "reachable"; models: readonly GatewayModel[] }>
  | Readonly<{ status: "unreachable"; reason: string }>
  | Readonly<{ status: "key-missing" }>;

export async function testConnection(
  connection: Connection,
  options: ListModelsOptions = {},
): Promise<ConnectionTestResult> {
  const definition = presetFor(connection.preset);
  if (definition.keyRequired && !(await options.readKey?.())) return { status: "key-missing" };
  try {
    return { status: "reachable", models: await listModels(connection, options) };
  } catch (error: unknown) {
    return { status: "unreachable", reason: unreachableReason(error, connection) };
  }
}
