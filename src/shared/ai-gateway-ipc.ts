// IPC contract for the configurable AI gateway: connection, key, model, function-route,
// and usage surfaces shared by the main process, preload, and renderer.

import { assertKeys, assertRecord } from "./operations-ipc-parser-utils";
import type { TaskId } from "./inference-ipc";

export type PresetId =
  "anthropic" | "openai" | "openrouter" | "vercel-ai-gateway" | "groq" | "mistral" | "ollama" | "lmstudio" | "custom";
export type Connection = Readonly<{ preset: PresetId; baseUrl?: string; displayName: string }>;
export type FunctionRoute = "auto" | Readonly<{ modelId: string }>;
/** The three bounded functions plus the Compose job: each routes to Auto or one model. */
export type AiFunctionId = TaskId | "compose";
export const AI_FUNCTION_IDS: readonly AiFunctionId[] = ["suggest-adapt", "explain", "summarize", "compose"];
export type FunctionRoutes = Readonly<Record<AiFunctionId, FunctionRoute>>;

export const AI_GATEWAY_IPC_CHANNELS = {
  connectionGet: "omni:ai:connection:get",
  connectionSet: "omni:ai:connection:set",
  connectionRemove: "omni:ai:connection:remove",
  keySet: "omni:ai:key:set",
  keyRemove: "omni:ai:key:remove",
  connectionTest: "omni:ai:connection:test",
  models: "omni:ai:models",
  functionsSet: "omni:ai:functions:set",
  usage: "omni:ai:usage",
  presets: "omni:ai:presets",
} as const;

export type AiConnectionResponse = Readonly<{
  connection?: Connection;
  keyState: "set" | "none";
  scope?: "remote" | "local";
}>;
export type AiPresetView = Readonly<{
  id: PresetId;
  displayName: string;
  keyPlaceholder: string;
  scope: "remote" | "local";
  keyRequired: boolean;
  defaultBaseUrl?: string;
}>;
export type AiPresetsResponse = Readonly<{ presets: readonly AiPresetView[] }>;
export type AiConnectionSetRequest = Readonly<{ preset: PresetId; baseUrl?: string }>;
export type AiKeySetRequest = Readonly<{ key: string }>;
export type AiModelView = Readonly<{
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  maxOutputTokens: number;
  tools: boolean | "unknown";
  structuredOutputs: boolean | "unknown";
  free: boolean;
  /** False when the provider decides the price per request (OpenRouter routers publish -1). */
  pricingKnown: boolean;
  cost: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
}>;
/** `unavailable` carries why the list is empty (endpoint unreachable) — a state, not an error. */
export type AiModelsResponse = Readonly<{ models: readonly AiModelView[]; unavailable?: string }>;
export type AiConnectionTestResponse =
  | Readonly<{ status: "reachable"; models: readonly AiModelView[] }>
  | Readonly<{ status: "unreachable"; reason: string }>
  | Readonly<{ status: "key-missing" }>;
export type AiFunctionsSetRequest = Readonly<{ functions: FunctionRoutes }>;
export type InferenceKeyMutationResponse =
  Readonly<{ status: "ok" }> | Readonly<{ status: "unavailable"; reason: string }>;
export type AiUsageResponse = Readonly<{
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}>;

export interface AiGatewayDesktopApi {
  getAiConnection(): Promise<AiConnectionResponse>;
  setAiConnection(request: AiConnectionSetRequest): Promise<AiConnectionResponse>;
  removeAiConnection(): Promise<AiConnectionResponse>;
  setAiKey(request: AiKeySetRequest): Promise<InferenceKeyMutationResponse>;
  removeAiKey(): Promise<InferenceKeyMutationResponse>;
  testAiConnection(): Promise<AiConnectionTestResponse>;
  listAiModels(): Promise<AiModelsResponse>;
  setAiFunctions(request: AiFunctionsSetRequest): Promise<AiFunctionsSetRequest>;
  getAiUsage(): Promise<AiUsageResponse>;
  listAiPresets(): Promise<AiPresetsResponse>;
}

const MAX_KEY_LENGTH = 4_000;

function readBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  if (value.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  return value;
}

function readId(value: unknown, label: string): string {
  const id = readBoundedText(value, label, 256).trim();
  // Provider registries use vendor prefixes (`anthropic/claude-sonnet-4.5`) and alias markers
  // (`~openai/gpt-latest` in OpenRouter's list): opaque, bounded, one line.
  if (!/^[A-Za-z0-9~][A-Za-z0-9._:/@~-]{0,255}$/.test(id)) throw new Error(`${label} is malformed.`);
  return id;
}

function readCapability(value: unknown, label: string): boolean | "unknown" {
  if (value !== true && value !== false && value !== "unknown") throw new Error(`${label} is invalid.`);
  return value;
}

function readModelNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function readPreset(value: unknown): PresetId {
  if (
    value !== "anthropic" &&
    value !== "openai" &&
    value !== "openrouter" &&
    value !== "vercel-ai-gateway" &&
    value !== "groq" &&
    value !== "mistral" &&
    value !== "ollama" &&
    value !== "lmstudio" &&
    value !== "custom"
  )
    throw new Error("Preset is invalid.");
  return value;
}

function parseConnection(value: unknown, required: boolean): Connection | undefined {
  if (value === undefined && !required) return undefined;
  const connection = assertRecord(value, "AI connection");
  assertKeys(connection, ["preset", "baseUrl", "displayName"], "AI connection");
  const preset = readPreset(connection.preset);
  if (typeof connection.displayName !== "string" || connection.displayName.trim() === "")
    throw new Error("AI connection display name is invalid.");
  if (connection.baseUrl !== undefined && (typeof connection.baseUrl !== "string" || connection.baseUrl.trim() === ""))
    throw new Error("AI connection base URL is invalid.");
  return {
    preset,
    ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
    displayName: connection.displayName,
  };
}

function parseFunctionRoutes(value: unknown): FunctionRoutes {
  const functions = assertRecord(value, "AI functions");
  assertKeys(functions, AI_FUNCTION_IDS, "AI functions");
  const result = {} as Record<AiFunctionId, FunctionRoute>;
  for (const task of AI_FUNCTION_IDS) {
    // `compose` arrived after the first v4 files were written: absent means Auto.
    const route = functions[task] ?? "auto";
    if (route === "auto") result[task] = route;
    else {
      const explicit = assertRecord(route, `AI function ${task}`);
      assertKeys(explicit, ["modelId"], `AI function ${task}`);
      result[task] = { modelId: readId(explicit.modelId, `AI function ${task} model id`) };
    }
  }
  return result;
}

export function parseAiConnectionSetRequest(value: unknown): AiConnectionSetRequest {
  const request = assertRecord(value, "AI connection request");
  assertKeys(request, ["preset", "baseUrl"], "AI connection request");
  const preset = readPreset(request.preset);
  if (request.baseUrl !== undefined)
    return { preset, baseUrl: readBoundedText(request.baseUrl, "AI connection base URL", 2_000) };
  return { preset };
}

export function parseAiKeySetRequest(value: unknown): AiKeySetRequest {
  const request = assertRecord(value, "AI key request");
  assertKeys(request, ["key"], "AI key request");
  return { key: readBoundedText(request.key, "Key", MAX_KEY_LENGTH) };
}

export function parseAiFunctionsSetRequest(value: unknown): AiFunctionsSetRequest {
  const request = assertRecord(value, "AI functions request");
  assertKeys(request, ["functions"], "AI functions request");
  return { functions: parseFunctionRoutes(request.functions) };
}

export function parseAiConnectionResponse(value: unknown): AiConnectionResponse {
  const response = assertRecord(value, "AI connection response");
  assertKeys(response, ["connection", "keyState", "scope"], "AI connection response");
  if (response.keyState !== "set" && response.keyState !== "none") throw new Error("AI key state is invalid.");
  if (response.scope !== undefined && response.scope !== "remote" && response.scope !== "local")
    throw new Error("AI connection scope is invalid.");
  const connection = parseConnection(response.connection, false);
  return {
    ...(connection ? { connection } : {}),
    keyState: response.keyState,
    ...(response.scope === undefined ? {} : { scope: response.scope }),
  };
}

export function parseAiPresetsResponse(value: unknown): AiPresetsResponse {
  const response = assertRecord(value, "AI presets response");
  assertKeys(response, ["presets"], "AI presets response");
  if (!Array.isArray(response.presets)) throw new Error("AI presets must be an array.");
  return {
    presets: response.presets.map((candidate) => {
      const preset = assertRecord(candidate, "AI preset");
      assertKeys(
        preset,
        ["id", "displayName", "keyPlaceholder", "scope", "keyRequired", "defaultBaseUrl"],
        "AI preset",
      );
      const id = readPreset(preset.id);
      if (typeof preset.displayName !== "string" || preset.displayName.trim() === "")
        throw new Error("AI preset display name is invalid.");
      if (typeof preset.keyPlaceholder !== "string" || preset.keyPlaceholder.trim() === "")
        throw new Error("AI preset key placeholder is invalid.");
      if (preset.scope !== "remote" && preset.scope !== "local") throw new Error("AI preset scope is invalid.");
      if (typeof preset.keyRequired !== "boolean") throw new Error("AI preset key requirement is invalid.");
      if (preset.defaultBaseUrl !== undefined && typeof preset.defaultBaseUrl !== "string")
        throw new Error("AI preset default base URL is invalid.");
      return {
        id,
        displayName: preset.displayName,
        keyPlaceholder: preset.keyPlaceholder,
        scope: preset.scope,
        keyRequired: preset.keyRequired,
        ...(preset.defaultBaseUrl === undefined ? {} : { defaultBaseUrl: preset.defaultBaseUrl }),
      };
    }),
  };
}

export function parseAiModelResponse(value: unknown): AiModelsResponse {
  const response = assertRecord(value, "AI models response");
  assertKeys(response, ["models", "unavailable"], "AI models response");
  if (!Array.isArray(response.models)) throw new Error("AI models must be an array.");
  const unavailable =
    response.unavailable === undefined ? undefined : readBoundedText(response.unavailable, "AI models reason", 500);
  return {
    models: response.models.map((candidate) => {
      const model = assertRecord(candidate, "AI model");
      assertKeys(
        model,
        [
          "id",
          "name",
          "provider",
          "contextWindow",
          "maxTokens",
          "maxOutputTokens",
          "tools",
          "structuredOutputs",
          "free",
          "pricingKnown",
          "cost",
        ],
        "AI model",
      );
      const cost = assertRecord(model.cost, "AI model cost");
      assertKeys(cost, ["input", "output", "cacheRead", "cacheWrite"], "AI model cost");
      if (typeof model.free !== "boolean") throw new Error("AI model free flag is invalid.");
      if (typeof model.pricingKnown !== "boolean") throw new Error("AI model pricing flag is invalid.");
      return {
        id: readId(model.id, "AI model id"),
        name: readBoundedText(model.name, "AI model name", 200),
        provider: readBoundedText(model.provider, "AI model provider", 100),
        contextWindow: readModelNumber(model.contextWindow, "AI model context window"),
        maxTokens: readModelNumber(model.maxTokens, "AI model max tokens"),
        maxOutputTokens: readModelNumber(model.maxOutputTokens, "AI model max output tokens"),
        tools: readCapability(model.tools, "AI model tools"),
        structuredOutputs: readCapability(model.structuredOutputs, "AI model structured outputs"),
        free: model.free,
        pricingKnown: model.pricingKnown,
        cost: {
          input: readModelNumber(cost.input, "AI model input cost"),
          output: readModelNumber(cost.output, "AI model output cost"),
          cacheRead: readModelNumber(cost.cacheRead, "AI model cache read cost"),
          cacheWrite: readModelNumber(cost.cacheWrite, "AI model cache write cost"),
        },
      };
    }),
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

export function parseAiConnectionTestResponse(value: unknown): AiConnectionTestResponse {
  const response = assertRecord(value, "AI connection test response");
  if (response.status === "key-missing") {
    assertKeys(response, ["status"], "AI connection test response");
    return { status: "key-missing" };
  }
  if (response.status === "unreachable") {
    assertKeys(response, ["status", "reason"], "AI connection test response");
    return { status: "unreachable", reason: readBoundedText(response.reason, "AI connection test reason", 500) };
  }
  if (response.status === "reachable") {
    assertKeys(response, ["status", "models"], "AI connection test response");
    return { status: "reachable", models: parseAiModelResponse({ models: response.models }).models };
  }
  throw new Error("AI connection test status is invalid.");
}

export function parseInferenceKeyMutationResponse(value: unknown): InferenceKeyMutationResponse {
  const response = assertRecord(value, "Key mutation response");
  if (response.status === "ok") {
    assertKeys(response, ["status"], "Key mutation response");
    return { status: "ok" };
  }
  if (response.status === "unavailable") {
    assertKeys(response, ["status", "reason"], "Key mutation response");
    return { status: "unavailable", reason: readBoundedText(response.reason, "Key mutation reason", 500) };
  }
  throw new Error("Key mutation response status is invalid.");
}

export function parseAiUsageResponse(value: unknown): AiUsageResponse {
  const response = assertRecord(value, "AI usage response");
  assertKeys(response, ["calls", "inputTokens", "outputTokens", "costUsd"], "AI usage response");
  if (
    typeof response.calls !== "number" ||
    typeof response.inputTokens !== "number" ||
    typeof response.outputTokens !== "number" ||
    typeof response.costUsd !== "number"
  )
    throw new Error("AI usage response is invalid.");
  return {
    calls: response.calls,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
  };
}
