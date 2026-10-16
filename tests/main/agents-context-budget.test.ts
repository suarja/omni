import { describe, expect, it } from "vitest";

import {
  budgetSections,
  calculateContextBudget,
  contextExhaustionReason,
  estimateTokens,
  isContextExhausted,
  maxTokensPerTurn,
  pruneContext,
  readFileByteLimit,
} from "../../src/main/agents/context-budget";

describe("agent context budget", () => {
  it("uses bytes divided by four and reserves one turn of output", () => {
    expect(estimateTokens("éééé")).toBe(2);
    expect(calculateContextBudget(200_000, 4_096)).toBe(115_904);
    expect(maxTokensPerTurn({ maxOutputTokens: 1_000 })).toBe(1_000);
    expect(maxTokensPerTurn({ maxOutputTokens: 8_000 })).toBe(4_096);
    expect(maxTokensPerTurn({})).toBe(4_096);
  });

  it("allocates more prompt space to high-priority sections and states list cuts", () => {
    const result = budgetSections(
      [
        { name: "system prompt", content: "S".repeat(1_000), priority: 6 },
        { name: "suggestions", content: "L".repeat(4_000), priority: 1, itemCount: 46 },
      ],
      300,
    );
    expect(result.sections[0]!.content.length).toBeGreaterThan(result.sections[1]!.content.length);
    expect(result.prompt).toContain("(list cut to");
    expect(result.estimate).toBeGreaterThan(0);
  });

  it("caps read_file to ten percent of the budget and 64 kB", () => {
    expect(readFileByteLimit(100_000)).toBe(40_000);
    expect(readFileByteLimit(1_000_000)).toBe(64 * 1024);
  });

  it("keeps the system, first user, and last six messages while pruning old tool results", () => {
    const firstUser = { role: "user" as const, content: "first", timestamp: 1 };
    const messages = [
      firstUser,
      {
        role: "toolResult" as const,
        toolCallId: "1",
        toolName: "search",
        content: [{ type: "text" as const, text: "old result ".repeat(200) }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult" as const,
        toolCallId: "2",
        toolName: "read_file",
        content: [{ type: "text" as const, text: "older result ".repeat(200) }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "assistant" as const,
        content: [],
        api: "x",
        provider: "x",
        model: "x",
        usage: {} as never,
        stopReason: "stop" as const,
        timestamp: 4,
      },
      { role: "user" as const, content: "last-1", timestamp: 5 },
      {
        role: "assistant" as const,
        content: [],
        api: "x",
        provider: "x",
        model: "x",
        usage: {} as never,
        stopReason: "stop" as const,
        timestamp: 6,
      },
      { role: "user" as const, content: "last-2", timestamp: 7 },
      {
        role: "assistant" as const,
        content: [],
        api: "x",
        provider: "x",
        model: "x",
        usage: {} as never,
        stopReason: "stop" as const,
        timestamp: 8,
      },
      { role: "user" as const, content: "last-3", timestamp: 9 },
      {
        role: "assistant" as const,
        content: [],
        api: "x",
        provider: "x",
        model: "x",
        usage: {} as never,
        stopReason: "stop" as const,
        timestamp: 10,
      },
    ];
    const result = pruneContext(messages, 60, "system prompt");
    expect(result[0]).toEqual(firstUser);
    expect(JSON.stringify(result[1])).toContain("(result of search pruned:");
    expect(JSON.stringify(result[2])).toContain("(result of read_file pruned:");
    expect(result.slice(-6)).toEqual(messages.slice(-6));
  });

  it("normalizes context exhaustion detection and wording", () => {
    expect(isContextExhausted({ stopReason: "length" })).toBe(true);
    expect(isContextExhausted({ errorMessage: "context_length_exceeded" })).toBe(true);
    expect(isContextExhausted({ errorMessage: "maximum context reached" })).toBe(true);
    expect(isContextExhausted({ errorMessage: "HTTP 413" })).toBe(true);
    expect(contextExhaustionReason(12_345, 200_000, 4)).toBe(
      "Context exhausted: ~12 k tokens for a 200 k window after 4 turns.",
    );
  });
});
