// The one budget (Brief 35a §6): bounds a task's input, serializes calls per provider (a
// queue — a session never has two in-flight calls racing the same provider), retries a
// retryable failure with backoff, and appends a monthly local log that never carries content.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { refusedCategories, type DataCategory, type DataCategoryPreferences } from "./data-categories";
import type { InferenceProvider, InferenceProviderId, InferenceResult, Task, TaskId } from "./provider";

export type Clock = Readonly<{ now(): number; sleep(milliseconds: number): Promise<void> }>;

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

/** Backoff delays between retries, in order — three retries: 1 s, 4 s, 16 s (a fourth, final attempt follows the last). */
const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 4_000, 16_000];

export type LogStatus = InferenceResult<unknown>["status"];

/**
 * Never `content`: the task, provider, token estimate, timing and outcome only. `model` (Brief
 * 35b) is present only when the call actually reached one — absent for `none`/`agent` and for
 * any call that never got a usage back, so an older log (with no `model` at all) still parses.
 */
export type InferenceLogEntry = Readonly<{
  at: string;
  task: TaskId | "agent";
  provider: InferenceProviderId;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  status: LogStatus;
  connectionId?: string;
  modelId?: string;
  costUsd: number;
}>;

export type UsageSummary = Readonly<{
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}>;

const logEntrySchema = z.object({
  at: z.string(),
  task: z.enum(["suggest-adapt", "explain", "summarize", "agent"]),
  provider: z.enum(["none", "pi", "agent"]),
  inputTokens: z.number(),
  outputTokens: z.number(),
  durationMs: z.number(),
  status: z.enum(["ok", "unavailable", "refused", "failed", "invalid-output"]),
  connectionId: z.string().optional(),
  modelId: z.string().optional(),
  costUsd: z.number().default(0),
});

// A corrupt or oversized log never blocks a call: usage becomes "unknown for this period", not a
// crash. Capped so an always-on background use never grows the file without bound.
const MAX_LOG_ENTRIES = 5_000;

function parseLog(value: unknown): InferenceLogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: InferenceLogEntry[] = [];
  for (const candidate of value) {
    const parsed = logEntrySchema.safeParse(candidate);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

async function readLog(filePath: string): Promise<InferenceLogEntry[]> {
  try {
    return parseLog(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  } catch {
    // Missing, corrupt, or unreadable: usage for this period is simply unknown, never a crash.
    return [];
  }
}

async function writeLogAtomically(filePath: string, entries: readonly InferenceLogEntry[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function inferenceLogFilePath(userDataPath: string): string {
  return join(resolve(userDataPath), "omni", "inference-log.json");
}

/** A call estimate before any usage is known, and the fallback logged for a non-"ok" outcome. */
function estimateTokens(input: string): number {
  return Math.ceil(input.length / 4);
}

/** A thrown error is retryable when it names a 429 or a 5xx status, or says so directly. */
function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && (status === 429 || (status >= 500 && status < 600))) return true;
  return (error as { retryable?: unknown }).retryable === true;
}

/**
 * A provider that reads `retry-after` off a 429 (Brief 35b's Anthropic provider) attaches it
 * here in milliseconds; the budget honours it in place of its own fixed backoff step for that
 * one attempt. Absent for every other error, where the fixed backoff array applies as before.
 */
function retryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && value > 0 ? value : undefined;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The inference call failed.";
}

export type BudgetRunParams<T> = Readonly<{
  provider: InferenceProvider;
  // `buildInput` is never called by the budget (the caller already built `input`): the input
  // type is irrelevant here, so this accepts a task for any input shape.
  task: Task<never, T>;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  categories?: readonly DataCategory[];
  dataCategoryPreferences: DataCategoryPreferences;
  model?: import("./gateway/models").GatewayModel;
  connection?: import("../../shared/ai-gateway-ipc").Connection;
}>;

export type Budget = Readonly<{
  run<T>(params: BudgetRunParams<T>): Promise<InferenceResult<T>>;
  usageThisMonth(): Promise<UsageSummary>;
  recordAgentUsage?(
    usage: Readonly<{
      connectionId: string;
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      status: LogStatus;
    }>,
  ): Promise<void>;
}>;

export type BudgetOptions = Readonly<{
  logFilePath: string;
  clock?: Clock;
  backoffMs?: readonly number[];
}>;

/**
 * Serializes calls to the same provider id (a `Promise` chain per id — one call in flight at a
 * time). A caller's own failure never poisons the queue for the next call: the chain is caught
 * internally before it is stored, and every call still resolves (or rejects) with its own outcome.
 */
function createProviderQueue(): <T>(providerId: InferenceProviderId, run: () => Promise<T>) => Promise<T> {
  const chains = new Map<InferenceProviderId, Promise<void>>();
  return (providerId, run) => {
    const previous = chains.get(providerId) ?? Promise.resolve();
    const result = previous.then(run, run);
    chains.set(
      providerId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };
}

export function createBudget(options: BudgetOptions): Budget {
  const clock = options.clock ?? createSystemClock();
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const enqueue = createProviderQueue();
  let logQueue = Promise.resolve();

  const appendLog = (entry: InferenceLogEntry): Promise<void> => {
    const result = logQueue.then(async () => {
      const existing = await readLog(options.logFilePath);
      const next = [...existing, entry].slice(-MAX_LOG_ENTRIES);
      await writeLogAtomically(options.logFilePath, next);
    });
    logQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const run = async <T>(params: BudgetRunParams<T>): Promise<InferenceResult<T>> =>
    enqueue(params.provider.id, async () => {
      const startedAt = clock.now();
      const finish = async (result: InferenceResult<T>): Promise<InferenceResult<T>> => {
        const usage =
          result.status === "ok" ? result.usage : { inputTokens: estimateTokens(params.input), outputTokens: 0 };
        await appendLog({
          at: new Date(clock.now()).toISOString(),
          task: params.task.id,
          provider: params.provider.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: clock.now() - startedAt,
          status: result.status,
          ...(usage.connectionId ? { connectionId: usage.connectionId } : {}),
          ...(usage.modelId ? { modelId: usage.modelId } : {}),
          costUsd: usage.costUsd ?? 0,
        });
        return result;
      };

      if (params.input.length > params.task.maxInputChars) {
        return finish({ status: "failed", reason: "Input exceeds the task's input bound." });
      }
      const refused = refusedCategories(
        params.provider.id,
        params.categories ?? params.task.categories,
        params.dataCategoryPreferences,
        params.provider.scope,
      );
      if (refused.length > 0) {
        return finish({
          status: "refused",
          reason: `Not opted in for a remote provider: ${refused.join(", ")}.`,
        });
      }

      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          const result = await params.provider.complete({
            task: params.task.id,
            system: params.system,
            input: params.input,
            schema: params.schema,
            maxOutputTokens: params.maxOutputTokens,
            ...(params.model ? { model: params.model } : {}),
            ...(params.connection ? { connection: params.connection } : {}),
          });
          // "Validated output" (Brief 35a's pipeline) is enforced here, once, for every provider
          // — a provider that skips its own schema check (or a test double that returns anything)
          // never reaches a command as a fabricated "ok".
          if (result.status === "ok") {
            const parsed = params.schema.safeParse(result.value);
            if (!parsed.success) {
              return finish({
                status: "invalid-output",
                reason: "The model's output did not match the task's schema.",
              });
            }
            return finish({ status: "ok", value: parsed.data, usage: result.usage });
          }
          return await finish(result);
        } catch (error: unknown) {
          if (isRetryable(error) && attempt <= backoff.length) {
            await clock.sleep(retryAfterMs(error) ?? backoff[attempt - 1]!);
            continue;
          }
          return finish({ status: "failed", reason: failureMessage(error) });
        }
      }
    });

  const usageThisMonth = async (): Promise<UsageSummary> => {
    const entries = await readLog(options.logFilePath);
    const monthKey = new Date(clock.now()).toISOString().slice(0, 7);
    return entries
      .filter((entry) => entry.at.slice(0, 7) === monthKey)
      .reduce<UsageSummary>(
        (total, entry) => ({
          calls: total.calls + 1,
          inputTokens: total.inputTokens + entry.inputTokens,
          outputTokens: total.outputTokens + entry.outputTokens,
          costUsd: total.costUsd + entry.costUsd,
        }),
        { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      );
  };

  const recordAgentUsage = async (
    usage: Readonly<{
      connectionId: string;
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      status: LogStatus;
    }>,
  ): Promise<void> => {
    await appendLog({
      at: new Date(clock.now()).toISOString(),
      task: "agent",
      provider: "agent",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: 0,
      status: usage.status,
      connectionId: usage.connectionId,
      modelId: usage.modelId,
      costUsd: usage.costUsd,
    });
  };

  return { run, usageThisMonth, recordAgentUsage };
}
