import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBudget, type Budget } from "../../src/main/inference/budget";
import { runExplainCommand } from "../../src/main/inference/commands/explain";
import { runSuggestCommand, type SuggestCommandCandidate } from "../../src/main/inference/commands/suggest";
import { runSummarizeCommand } from "../../src/main/inference/commands/summarize";
import type { DataCategoryPreferences } from "../../src/main/inference/data-categories";
import { createNoneProvider } from "../../src/main/inference/providers/none";
import type { InferenceProvider, InferenceResult } from "../../src/main/inference/provider";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempBudget(): Promise<Budget> {
  const root = await mkdtemp(join(tmpdir(), "omni-inference-commands-"));
  roots.push(root);
  return createBudget({ logFilePath: join(root, "inference-log.json") });
}

const PREFERENCES_ALL_ON: DataCategoryPreferences = {
  marketplaceContent: true,
  stackFiles: true,
  transcripts: true,
  processCommands: true,
};
const PREFERENCES_ALL_OFF: DataCategoryPreferences = {
  marketplaceContent: false,
  stackFiles: false,
  transcripts: false,
  processCommands: false,
};

function fakeCompletingProvider(
  id: InferenceProvider["id"],
  respond: (task: string) => InferenceResult<unknown>,
): InferenceProvider {
  return {
    id,
    capabilities: { maxInputChars: 100_000, structuredOutput: true, streaming: false },
    complete: async (call) => respond(call.task) as never,
  };
}

const CANDIDATES: readonly SuggestCommandCandidate[] = [
  { ownerRepo: "vercel-labs/skills", skill: "next-skill", name: "Next skill", why: ["next"], score: 12 },
  { ownerRepo: "vercel-labs/skills", skill: "react-skill", name: "React skill", why: ["react"], score: 9 },
];

describe("Suggest command", () => {
  it("returns the deterministic list unchanged, with intelligence unavailable, for the none provider", async () => {
    const budget = await tempBudget();
    const outcome = await runSuggestCommand(
      { profileTags: [], candidates: CANDIDATES },
      createNoneProvider(),
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome.intelligence).toBe("unavailable");
    expect(outcome.result.items).toEqual(CANDIDATES.map((candidate) => ({ ...candidate, adapted: false })));
  });

  it("merges valid picks back into the ranked list as adapted, with their reason", async () => {
    const budget = await tempBudget();
    const provider = fakeCompletingProvider("agent", () => ({
      status: "ok",
      value: { picks: [{ skill: "next-skill", ownerRepo: "vercel-labs/skills", reason: "Matches Next.js directly." }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const outcome = await runSuggestCommand(
      { profileTags: [], candidates: CANDIDATES },
      provider,
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome.intelligence).toBe("ok");
    expect(outcome.result.items).toEqual([
      { ...CANDIDATES[0]!, adapted: true, reason: "Matches Next.js directly." },
      { ...CANDIDATES[1]!, adapted: false },
    ]);
  });

  it("resolves a loosely echoed pick to the offered candidate (repo/skill as one path, or the skill alone)", async () => {
    const budget = await tempBudget();
    const provider = fakeCompletingProvider("agent", () => ({
      status: "ok",
      value: {
        picks: [
          { skill: "next-skill", ownerRepo: "vercel-labs/skills/next-skill", reason: "Echoed as one path." },
          { skill: CANDIDATES[1]!.skill, ownerRepo: "unknown/repo", reason: "Skill alone." },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const outcome = await runSuggestCommand(
      { profileTags: [], candidates: CANDIDATES },
      provider,
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome.intelligence).toBe("ok");
    expect(outcome.result.items.map((item) => item.reason)).toEqual(["Echoed as one path.", "Skill alone."]);
  });

  it("restricts picks to the given candidates — a pick naming an unknown skill is dropped", async () => {
    const budget = await tempBudget();
    const provider = fakeCompletingProvider("agent", () => ({
      status: "ok",
      value: {
        picks: [
          { skill: "next-skill", ownerRepo: "vercel-labs/skills", reason: "Fits." },
          { skill: "invented-skill", ownerRepo: "someone/else", reason: "Should never appear." },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const outcome = await runSuggestCommand(
      { profileTags: [], candidates: CANDIDATES },
      provider,
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome.result.items.every((item) => item.reason !== "Should never appear.")).toBe(true);
    expect(outcome.result.items.find((item) => item.skill === "next-skill")?.adapted).toBe(true);
  });

  it("reports invalid-output and keeps the deterministic list when every pick is unknown", async () => {
    const budget = await tempBudget();
    const provider = fakeCompletingProvider("agent", () => ({
      status: "ok",
      value: { picks: [{ skill: "invented-skill", ownerRepo: "someone/else", reason: "x" }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const outcome = await runSuggestCommand(
      { profileTags: [], candidates: CANDIDATES },
      provider,
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome.intelligence).toBe("invalid-output");
    expect(outcome.intelligence === "invalid-output" && outcome.reason).toContain(
      "returned: someone/else/invented-skill",
    );
    expect(outcome.result.items).toEqual(CANDIDATES.map((candidate) => ({ ...candidate, adapted: false })));
  });

  it("refuses a remote provider not opted in for its data categories", async () => {
    const budget = await tempBudget();
    let called = false;
    const provider = fakeCompletingProvider("pi", () => {
      called = true;
      return { status: "ok", value: { picks: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const outcome = await runSuggestCommand(
      { profileTags: [], candidates: CANDIDATES },
      provider,
      budget,
      PREFERENCES_ALL_OFF,
    );
    expect(outcome.intelligence).toBe("refused");
    expect(called).toBe(false);
    expect(outcome.result.items).toEqual(CANDIDATES.map((candidate) => ({ ...candidate, adapted: false })));
  });
});

describe("Explain command", () => {
  it("returns an empty deterministic result with intelligence unavailable for the none provider", async () => {
    const budget = await tempBudget();
    const outcome = await runExplainCommand(
      { findingKind: "exact-duplicate", left: "left side", right: "right side" },
      createNoneProvider(),
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome).toEqual({ intelligence: "unavailable", reason: expect.any(String), result: {} });
  });

  it("returns the model's explanation and keep on a valid response", async () => {
    const budget = await tempBudget();
    const provider = fakeCompletingProvider("agent", () => ({
      status: "ok",
      value: { explanation: "The right side is more complete.", keep: "right" },
      usage: { inputTokens: 4, outputTokens: 6 },
    }));
    const outcome = await runExplainCommand(
      { findingKind: "variant", left: "left side", right: "right side" },
      provider,
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome).toEqual({
      intelligence: "ok",
      result: { explanation: "The right side is more complete.", keep: "right" },
    });
  });

  it("reports invalid-output and an empty result when the schema rejects the response", async () => {
    const budget = await tempBudget();
    const provider = fakeCompletingProvider("agent", () => ({
      status: "ok",
      value: { explanation: "x".repeat(500), keep: "right" },
      usage: { inputTokens: 4, outputTokens: 6 },
    }));
    const outcome = await runExplainCommand(
      { findingKind: "variant", left: "left side", right: "right side" },
      provider,
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome.intelligence).toBe("invalid-output");
    expect(outcome.result).toEqual({});
  });
});

describe("Summarize command", () => {
  it("returns an empty deterministic result with intelligence unavailable for the none provider", async () => {
    const budget = await tempBudget();
    const outcome = await runSummarizeCommand(
      { kind: "session", lines: ["Asked first: do the thing."] },
      createNoneProvider(),
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome).toEqual({ intelligence: "unavailable", reason: expect.any(String), result: {} });
  });

  it("returns unavailable without calling the provider when there is no evidence", async () => {
    const budget = await tempBudget();
    let called = false;
    const provider = fakeCompletingProvider("agent", () => {
      called = true;
      return { status: "ok", value: { sentence: "x" }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const outcome = await runSummarizeCommand({ kind: "session", lines: [] }, provider, budget, PREFERENCES_ALL_ON);
    expect(outcome.intelligence).toBe("unavailable");
    expect(called).toBe(false);
  });

  it("returns the model's sentence on a valid response", async () => {
    const budget = await tempBudget();
    const provider = fakeCompletingProvider("agent", () => ({
      status: "ok",
      value: { sentence: "Implementing the summarize hook." },
      usage: { inputTokens: 4, outputTokens: 6 },
    }));
    const outcome = await runSummarizeCommand(
      { kind: "session", lines: ["Asked first: do the thing."] },
      provider,
      budget,
      PREFERENCES_ALL_ON,
    );
    expect(outcome).toEqual({ intelligence: "ok", result: { sentence: "Implementing the summarize hook." } });
  });
});
