import { describe, expect, it } from "vitest";

import {
  parseAiConnectionResponse,
  parseAiConnectionSetRequest,
  parseAiConnectionTestResponse,
  parseAiFunctionsSetRequest,
  parseAiKeySetRequest,
  parseAiModelResponse,
  parseAiPresetsResponse,
  parseAiUsageResponse,
  parseInferenceKeyMutationResponse,
} from "../../src/shared/ai-gateway-ipc";
import {
  parseInferenceDryRunRequest,
  parseInferenceDryRunResponse,
  parseInferenceRunRequest,
  parseInferenceRunResponse,
} from "../../src/shared/inference-ipc";

describe("AI gateway IPC parsers", () => {
  it("accepts the renderer-safe preset metadata contract", () => {
    expect(
      parseAiPresetsResponse({
        presets: [
          {
            id: "ollama",
            displayName: "Ollama",
            keyPlaceholder: "No key",
            scope: "local",
            keyRequired: false,
            defaultBaseUrl: "http://localhost:11434/v1",
          },
        ],
      }),
    ).toEqual({
      presets: [
        {
          id: "ollama",
          displayName: "Ollama",
          keyPlaceholder: "No key",
          scope: "local",
          keyRequired: false,
          defaultBaseUrl: "http://localhost:11434/v1",
        },
      ],
    });
  });

  it("rejects key-bearing or malformed preset metadata", () => {
    expect(() =>
      parseAiPresetsResponse({
        presets: [
          {
            id: "ollama",
            displayName: "Ollama",
            keyPlaceholder: "No key",
            scope: "local",
            keyRequired: false,
            key: "secret",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseAiPresetsResponse({
        presets: [{ id: "unknown", displayName: "Unknown", keyPlaceholder: "x", scope: "remote", keyRequired: true }],
      }),
    ).toThrow();
  });

  it("accepts connection, key, function, model, and connection-test contracts", () => {
    expect(parseAiConnectionSetRequest({ preset: "ollama" })).toEqual({ preset: "ollama" });
    expect(parseAiKeySetRequest({ key: "secret" })).toEqual({ key: "secret" });
    expect(
      parseAiFunctionsSetRequest({
        functions: { "suggest-adapt": "auto", explain: { modelId: "vendor/model:v1" }, summarize: "auto" },
      }),
    ).toEqual({
      // `compose` absent in a request written before it existed → Auto.
      functions: {
        "suggest-adapt": "auto",
        explain: { modelId: "vendor/model:v1" },
        summarize: "auto",
        compose: "auto",
      },
    });
    const model = {
      id: "vendor/model:v1",
      name: "Model",
      provider: "ollama",
      contextWindow: 0,
      maxTokens: 0,
      maxOutputTokens: 0,
      tools: "unknown",
      structuredOutputs: "unknown",
      free: true,
      pricingKnown: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(parseAiModelResponse({ models: [model] })).toEqual({ models: [model] });
    // OpenRouter's registry as pi lists it: vendor prefixes and `~` alias ids must pass.
    for (const id of ["anthropic/claude-sonnet-4.5", "~openai/gpt-latest", "openai/gpt-5-mini"])
      expect(parseAiModelResponse({ models: [{ ...model, id }] }).models[0]?.id).toBe(id);
    expect(() => parseAiModelResponse({ models: [{ ...model, id: "bad id" }] })).toThrow(/malformed/);
    expect(
      parseAiModelResponse({ models: [], unavailable: "No server answers at http://localhost:11434/v1." }),
    ).toEqual({
      models: [],
      unavailable: "No server answers at http://localhost:11434/v1.",
    });
    expect(parseAiConnectionTestResponse({ status: "reachable", models: [model] })).toEqual({
      status: "reachable",
      models: [model],
    });
    expect(
      parseAiConnectionResponse({
        connection: { preset: "ollama", displayName: "Ollama" },
        keyState: "none",
        scope: "local",
      }),
    ).toEqual({ connection: { preset: "ollama", displayName: "Ollama" }, keyState: "none", scope: "local" });
  });

  it("rejects unknown fields and key-bearing connection payloads", () => {
    expect(() => parseAiConnectionSetRequest({ preset: "ollama", key: "secret" })).toThrow();
    expect(() => parseAiKeySetRequest({ key: "secret", preset: "ollama" })).toThrow();
    expect(() =>
      parseAiConnectionResponse({
        connection: { preset: "ollama", displayName: "Ollama", key: "secret" },
        keyState: "set",
      }),
    ).toThrow();
  });

  it("parses usage without exposing a legacy status envelope", () => {
    expect(parseAiUsageResponse({ calls: 3, inputTokens: 100, outputTokens: 50, costUsd: 0.5 })).toEqual({
      calls: 3,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.5,
    });
    expect(() =>
      parseAiUsageResponse({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, status: "ok" }),
    ).toThrow();
  });
});

describe("parseInferenceKeyMutationResponse", () => {
  it("round-trips an ok response", () => {
    expect(parseInferenceKeyMutationResponse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("round-trips an unavailable response with a reason", () => {
    expect(parseInferenceKeyMutationResponse({ status: "unavailable", reason: "No encryption." })).toEqual({
      status: "unavailable",
      reason: "No encryption.",
    });
  });

  it("never accepts a response carrying the key back — the field is simply not part of the contract", () => {
    expect(() => parseInferenceKeyMutationResponse({ status: "ok", key: "sk-ant-x" })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => parseInferenceKeyMutationResponse({ status: "stored" })).toThrow();
  });
});

describe("parseInferenceRunRequest", () => {
  it("accepts a suggest request", () => {
    expect(parseInferenceRunRequest({ command: "suggest", projectId: "proj-1", limit: 5, bypassCache: true })).toEqual({
      command: "suggest",
      projectId: "proj-1",
      limit: 5,
      bypassCache: true,
    });
  });

  it("accepts a suggest request without a limit", () => {
    expect(parseInferenceRunRequest({ command: "suggest", projectId: "proj-1" })).toEqual({
      command: "suggest",
      projectId: "proj-1",
    });
  });

  it("rejects a suggest limit over the bound", () => {
    expect(() => parseInferenceRunRequest({ command: "suggest", projectId: "proj-1", limit: 21 })).toThrow();
  });

  it("rejects a non-boolean cache bypass", () => {
    expect(() => parseInferenceRunRequest({ command: "suggest", projectId: "proj-1", bypassCache: "yes" })).toThrow();
  });

  it("accepts an explain request", () => {
    expect(parseInferenceRunRequest({ command: "explain", findingKind: "variant", left: "l", right: "r" })).toEqual({
      command: "explain",
      findingKind: "variant",
      left: "l",
      right: "r",
    });
  });

  it("rejects an explain side over the length bound", () => {
    expect(() =>
      parseInferenceRunRequest({ command: "explain", findingKind: "variant", left: "x".repeat(4_001), right: "r" }),
    ).toThrow();
  });

  it("accepts a summarize request", () => {
    expect(parseInferenceRunRequest({ command: "summarize", kind: "session", lines: ["a", "b"] })).toEqual({
      command: "summarize",
      kind: "session",
      lines: ["a", "b"],
    });
  });

  it("rejects more than 20 summarize lines", () => {
    const lines = Array.from({ length: 21 }, (_, index) => `line-${index}`);
    expect(() => parseInferenceRunRequest({ command: "summarize", kind: "session", lines })).toThrow();
  });

  it("rejects an unknown command", () => {
    expect(() => parseInferenceRunRequest({ command: "compose" })).toThrow();
  });
});

const validSuggestEntry = {
  source: "skills.sh" as const,
  ownerRepo: "owner/repo",
  skill: "a-skill",
  name: "a-skill",
  hasSkillMd: true,
  tags: ["react"],
  installs: 42,
  official: true,
};

describe("parseInferenceRunResponse", () => {
  it("round-trips a suggest response with an adapted item and its reason", () => {
    const response = {
      command: "suggest" as const,
      intelligence: "ok" as const,
      items: [{ entry: validSuggestEntry, score: 12, matchedTags: ["react"], adapted: true, reason: "Fits well." }],
    };
    expect(parseInferenceRunResponse(response)).toEqual(response);
  });

  it("round-trips a suggest response with intelligence unavailable and no adapted items", () => {
    const response = {
      command: "suggest" as const,
      intelligence: "unavailable" as const,
      reason: "No intelligence provider is enabled.",
      items: [{ entry: validSuggestEntry, score: 12, matchedTags: ["react"], adapted: false }],
    };
    expect(parseInferenceRunResponse(response)).toEqual(response);
  });

  it("round-trips an explain response", () => {
    const response = {
      command: "explain" as const,
      intelligence: "ok" as const,
      explanation: "The right side is more complete.",
      keep: "right" as const,
    };
    expect(parseInferenceRunResponse(response)).toEqual(response);
  });

  it("round-trips a summarize response", () => {
    const response = { command: "summarize" as const, intelligence: "ok" as const, sentence: "Doing the thing." };
    expect(parseInferenceRunResponse(response)).toEqual(response);
  });

  it("rejects an invalid keep value on an explain response", () => {
    expect(() =>
      parseInferenceRunResponse({ command: "explain", intelligence: "ok", explanation: "x", keep: "both" }),
    ).toThrow();
  });

  it("rejects an unknown command", () => {
    expect(() => parseInferenceRunResponse({ command: "compose", intelligence: "ok" })).toThrow();
  });
});

describe("parseInferenceDryRunRequest", () => {
  it("accepts a suggest dry-run request", () => {
    const request = {
      command: "suggest" as const,
      input: {
        profileTags: [{ id: "next", label: "Next.js", evidenceCount: 2 }],
        candidates: [
          {
            ownerRepo: "vercel-labs/skills",
            skill: "next-skill",
            name: "Next skill",
            description: "Patterns.",
            why: ["next"],
          },
        ],
      },
    };
    expect(parseInferenceDryRunRequest(request)).toEqual(request);
  });

  it("accepts a suggest dry-run request with no candidates", () => {
    const request = { command: "suggest" as const, input: { profileTags: [], candidates: [] } };
    expect(parseInferenceDryRunRequest(request)).toEqual(request);
  });

  it("rejects more candidates than the bound", () => {
    const candidates = Array.from({ length: 21 }, (_, index) => ({
      ownerRepo: "owner/repo",
      skill: `skill-${index}`,
      name: `Skill ${index}`,
      why: [] as string[],
    }));
    expect(() => parseInferenceDryRunRequest({ command: "suggest", input: { profileTags: [], candidates } })).toThrow();
  });

  it("accepts an explain dry-run request", () => {
    const request = { command: "explain" as const, input: { findingKind: "variant", left: "l", right: "r" } };
    expect(parseInferenceDryRunRequest(request)).toEqual(request);
  });

  it("accepts a summarize dry-run request", () => {
    const request = { command: "summarize" as const, input: { kind: "session" as const, lines: ["a", "b"] } };
    expect(parseInferenceDryRunRequest(request)).toEqual(request);
  });

  it("rejects an unknown command", () => {
    expect(() => parseInferenceDryRunRequest({ command: "compose", input: {} })).toThrow();
  });
});

describe("parseInferenceDryRunResponse", () => {
  it("round-trips a full dry-run response", () => {
    const response = {
      modelId: "claude-sonnet-5",
      provider: "anthropic",
      system: "You choose which candidates fit.",
      userContent: "Return your picks as JSON only.",
      toolSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    };
    expect(parseInferenceDryRunResponse(response)).toEqual(response);
  });

  it("rejects a response with no toolSchema", () => {
    expect(() =>
      parseInferenceDryRunResponse({
        modelId: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        system: [{ text: "x", cached: "yes" }],
        userContent: "y",
      }),
    ).toThrow();
  });

  it("rejects a system block whose cached flag is not a boolean", () => {
    expect(() =>
      parseInferenceDryRunResponse({
        modelId: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        system: [{ text: "x", cached: "yes" }],
        userContent: "y",
        toolSchema: {},
      }),
    ).toThrow();
  });
});
