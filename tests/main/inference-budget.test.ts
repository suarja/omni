import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createBudget, type Clock } from "../../src/main/inference/budget";
import type { InferenceProvider, InferenceResult, Task } from "../../src/main/inference/provider";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempLogPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-inference-log-"));
  roots.push(root);
  return join(root, "inference-log.json");
}

function fakeClock(): Readonly<{ clock: Clock; sleeps: number[] }> {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
      },
    },
  };
}

const outputSchema = z.object({ sentence: z.string() });
const testTask: Task<Readonly<{ text: string }>, z.infer<typeof outputSchema>> = {
  id: "summarize",
  categories: ["transcripts"],
  maxInputChars: 20,
  system: "Test system.",
  schema: outputSchema,
  buildInput: (input) => input.text,
};

/**
 * A test double's `respond` returns a fixed, non-generic result — assignable to `InferenceResult<T>`
 * for whatever `T` a real caller asks for only via this one cast, kept in this single helper.
 */
function testProvider(
  id: InferenceProvider["id"],
  respond: () => Promise<InferenceResult<unknown>> | InferenceResult<unknown>,
): InferenceProvider {
  return {
    id,
    capabilities: { maxInputChars: 20, structuredOutput: true, streaming: false },
    complete: async () => (await respond()) as never,
  };
}

function localProvider(respond: () => Promise<InferenceResult<unknown>> | InferenceResult<unknown>): InferenceProvider {
  return testProvider("none", respond);
}

const PREFERENCES_ALL_OFF = {
  marketplaceContent: false,
  stackFiles: false,
  transcripts: false,
  processCommands: false,
};
const PREFERENCES_ALL_ON = {
  marketplaceContent: true,
  stackFiles: true,
  transcripts: true,
  processCommands: true,
};

describe("inference budget", () => {
  it("fails a call whose input exceeds the task's bound, without ever calling the provider", async () => {
    const logFilePath = await tempLogPath();
    let calls = 0;
    const budget = createBudget({ logFilePath });
    const provider = localProvider(async () => {
      calls += 1;
      return { status: "ok", value: { sentence: "x" }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const result = await budget.run({
      provider,
      task: testTask,
      system: testTask.system,
      input: "x".repeat(21),
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    expect(result).toEqual({ status: "failed", reason: "Input exceeds the task's input bound." });
    expect(calls).toBe(0);
  });

  it("refuses a remote provider not opted in for the task's categories, without calling it", async () => {
    const logFilePath = await tempLogPath();
    let calls = 0;
    const budget = createBudget({ logFilePath });
    const provider = testProvider("pi", () => {
      calls += 1;
      return { status: "ok", value: { sentence: "x" }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const result = await budget.run({
      provider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_OFF,
    });
    expect(result.status).toBe("refused");
    expect(calls).toBe(0);
  });

  it("never refuses a local provider regardless of data category preferences", async () => {
    const logFilePath = await tempLogPath();
    const budget = createBudget({ logFilePath });
    const provider = localProvider(async () => ({
      status: "ok",
      value: { sentence: "x" },
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const result = await budget.run({
      provider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_OFF,
    });
    expect(result.status).toBe("ok");
  });

  it("retries a retryable failure three times with 1s, 4s, 16s backoff, then succeeds", async () => {
    const logFilePath = await tempLogPath();
    const { clock, sleeps } = fakeClock();
    const budget = createBudget({ logFilePath, clock });
    let attempt = 0;
    const provider = localProvider(async () => {
      attempt += 1;
      if (attempt <= 3) {
        const error = new Error("Too many requests.") as Error & { status: number };
        error.status = 429;
        throw error;
      }
      return { status: "ok", value: { sentence: "done" }, usage: { inputTokens: 2, outputTokens: 3 } };
    });
    const result = await budget.run({
      provider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    expect(result).toEqual({ status: "ok", value: { sentence: "done" }, usage: { inputTokens: 2, outputTokens: 3 } });
    expect(attempt).toBe(4);
    expect(sleeps).toEqual([1_000, 4_000, 16_000]);
  });

  it("gives up after three retries and returns a failed result, never a fabricated one", async () => {
    const logFilePath = await tempLogPath();
    const { clock, sleeps } = fakeClock();
    const budget = createBudget({ logFilePath, clock });
    let attempt = 0;
    const provider = localProvider(async () => {
      attempt += 1;
      const error = new Error("Server error.") as Error & { status: number };
      error.status = 503;
      throw error;
    });
    const result = await budget.run({
      provider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    expect(result).toEqual({ status: "failed", reason: "Server error." });
    expect(attempt).toBe(4);
    expect(sleeps).toEqual([1_000, 4_000, 16_000]);
  });

  it("never retries a non-retryable failure", async () => {
    const logFilePath = await tempLogPath();
    const { clock, sleeps } = fakeClock();
    const budget = createBudget({ logFilePath, clock });
    let attempt = 0;
    const provider = localProvider(async () => {
      attempt += 1;
      throw new Error("Malformed request.");
    });
    const result = await budget.run({
      provider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    expect(result).toEqual({ status: "failed", reason: "Malformed request." });
    expect(attempt).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("serializes calls to the same provider: a second call never starts before the first resolves", async () => {
    const logFilePath = await tempLogPath();
    const budget = createBudget({ logFilePath });
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const provider = localProvider(async (): Promise<InferenceResult<z.infer<typeof outputSchema>>> => {
      if (!releaseFirst) {
        order.push("first-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("first-end");
        return { status: "ok", value: { sentence: "first" }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      order.push("second-start");
      return { status: "ok", value: { sentence: "second" }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const runParams = {
      provider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    };
    const first = budget.run(runParams);
    const second = budget.run(runParams);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("logs never carry content — only the task, provider, token estimate, timing, and status", async () => {
    const logFilePath = await tempLogPath();
    const budget = createBudget({ logFilePath });
    const provider = localProvider(async () => ({
      status: "ok",
      value: { sentence: "done" },
      usage: { inputTokens: 5, outputTokens: 7 },
    }));
    await budget.run({
      provider,
      task: testTask,
      system: "a secret system prompt",
      input: "secret input content",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    const entries = JSON.parse(await readFile(logFilePath, "utf8")) as readonly Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]!).sort()).toEqual(
      ["at", "costUsd", "durationMs", "inputTokens", "outputTokens", "provider", "status", "task"].sort(),
    );
    expect(entries[0]).toMatchObject({
      task: "summarize",
      provider: "none",
      inputTokens: 5,
      outputTokens: 7,
      costUsd: 0,
      status: "ok",
    });
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

  it("logs an estimated token count (chars / 4) for a non-ok outcome", async () => {
    const logFilePath = await tempLogPath();
    const budget = createBudget({ logFilePath });
    const provider = localProvider(async () => ({ status: "unavailable", reason: "No provider." }));
    await budget.run({
      provider,
      task: testTask,
      system: testTask.system,
      input: "12345678",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    const entries = JSON.parse(await readFile(logFilePath, "utf8")) as readonly Record<string, unknown>[];
    expect(entries[0]).toMatchObject({ status: "unavailable", inputTokens: 2, outputTokens: 0 });
  });

  it("computes this month's usage from the log, keyed by the same clock used to write it", async () => {
    const logFilePath = await tempLogPath();
    const { clock } = fakeClock();
    const budget = createBudget({ logFilePath, clock });
    const okProvider = localProvider(async () => ({
      status: "ok",
      value: { sentence: "done" },
      usage: { inputTokens: 10, outputTokens: 20 },
    }));
    await budget.run({
      provider: okProvider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    await budget.run({
      provider: okProvider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    await expect(budget.usageThisMonth()).resolves.toEqual({
      calls: 2,
      inputTokens: 20,
      outputTokens: 40,
      costUsd: 0,
    });
  });

  it("sums the cost reported by pi usage on each ok entry", async () => {
    const logFilePath = await tempLogPath();
    const { clock } = fakeClock();
    const budget = createBudget({ logFilePath, clock });
    const haikuProvider = localProvider(async () => ({
      status: "ok",
      value: { sentence: "done" },
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costUsd: 6,
        modelId: "claude-haiku-4-5-20251001",
        connectionId: "anthropic",
      },
    }));
    await budget.run({
      provider: haikuProvider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    await expect(budget.usageThisMonth()).resolves.toEqual({
      calls: 1,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: 6,
    });
  });

  it("honours a thrown error's retryAfterMs instead of the fixed backoff step, once", async () => {
    const logFilePath = await tempLogPath();
    const { clock, sleeps } = fakeClock();
    const budget = createBudget({ logFilePath, clock });
    let attempt = 0;
    const provider = localProvider(async () => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error("Too many requests.") as Error & { status: number; retryAfterMs: number };
        error.status = 429;
        error.retryAfterMs = 2_000;
        throw error;
      }
      return { status: "ok", value: { sentence: "done" }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const result = await budget.run({
      provider,
      task: testTask,
      system: testTask.system,
      input: "hi",
      schema: outputSchema,
      maxOutputTokens: 10,
      dataCategoryPreferences: PREFERENCES_ALL_ON,
    });
    expect(result.status).toBe("ok");
    expect(sleeps).toEqual([2_000]);
  });
});
