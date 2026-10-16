// The replaceable inference seam: commands depend on this contract, while pi and gateway
// details stay behind `providers/pi.ts` and `gateway/`.

import type { z } from "zod";

import type { DataCategory } from "./data-categories";
import type { Connection } from "../../shared/ai-gateway-ipc";
import type { GatewayModel } from "./gateway/models";

export type InferenceProviderId = "none" | "pi" | "agent";

/** The three first tasks (Brief 35a); later slices add to this union, never repurpose a value. */
export type { TaskId } from "../../shared/inference-ipc";
import type { TaskId } from "../../shared/inference-ipc";

export type InferenceCapabilities = Readonly<{
  maxInputChars: number;
  structuredOutput: boolean;
  streaming: boolean;
}>;

export type InferenceCall<T> = Readonly<{
  task: TaskId;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  model?: GatewayModel;
  connection?: Connection;
}>;

/**
 * `model` (Brief 35b) is set by a provider that actually calls one — `undefined` for `none`/
 * `agent`, and for any provider whose call did not reach a model at all. It travels only as far
 * as the local log (never content, never the key), where it lets the budget's cost estimate
 * carry pi's reported cost into the local usage log.
 */
export type InferenceUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  connectionId?: string;
  modelId?: string;
  model?: string;
}>;

/** A parse failure, a refusal, or an empty budget are never fabricated into a value — only "ok" carries one. */
export type InferenceFailureStatus = "unavailable" | "refused" | "failed" | "invalid-output";

export type InferenceResult<T> =
  | Readonly<{ status: "ok"; value: T; usage: InferenceUsage }>
  | Readonly<{ status: InferenceFailureStatus; reason: string }>;

export type InferenceProvider = Readonly<{
  id: InferenceProviderId;
  scope?: "remote" | "local";
  capabilities: InferenceCapabilities;
  complete<T>(call: InferenceCall<T>): Promise<InferenceResult<T>>;
}>;

/**
 * One task (Brief 35a: `suggest-adapt`, `explain`, `summarize`): a bounded, factual prompt with
 * a schema that forces the output's shape, plus the data categories it would carry off the
 * machine on a remote provider (`data-categories.ts`) and the deterministic-to-text step
 * (`buildInput`) that turns a command's typed input into the string sent to `complete`.
 */
export type Task<TInput, TOutput> = Readonly<{
  id: TaskId;
  categories: readonly DataCategory[];
  maxInputChars: number;
  system: string;
  schema: z.ZodType<TOutput>;
  buildInput(input: TInput): string;
}>;

/**
 * Every command's result (`commands/*.ts`): `result` is always the deterministic baseline,
 * untouched on any non-"ok" outcome — the UI never renders a fabricated value, and with the
 * `none` provider it is byte-for-byte what the command would have returned with no intelligence
 * layer at all.
 */
export type CommandResult<T> =
  | Readonly<{ intelligence: "ok"; result: T }>
  | Readonly<{ intelligence: InferenceFailureStatus; reason: string; result: T }>;
