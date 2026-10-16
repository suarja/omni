import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBudget } from "../../src/main/inference/budget";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createJobHarness } from "../../src/main/agents/harness";
import { createJobTools, type JobGrants } from "../../src/main/agents/tools";
import type { AgentRouter } from "../../src/main/agent-gateway/server";

const model = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet",
  api: "anthropic-messages",
  provider: "anthropic",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
} as Model<"anthropic-messages">;

const roots: { project: string; marketplace: string } = { project: "", marketplace: "" };
let tempRoot = "";

function grants(): JobGrants {
  return {
    projectId: "project-one",
    projectRoot: roots.project,
    marketplaceRoot: roots.marketplace,
    sourceId: "personal",
    packageId: "plugin",
  };
}

function router(calls: string[] = []): AgentRouter {
  return {
    handle: async (method, params) => {
      calls.push(method);
      if (method === "list_project_assets")
        return { status: "ready", unmanaged: [{ relativePath: "CLAUDE.md", displayPath: "CLAUDE.md" }], managed: [] };
      if (method === "list_marketplace")
        return { status: "ready", packages: [{ id: "plugin", name: "Plugin", artifacts: [] }] };
      if (method === "preview_create_skill")
        return { requestId: `request-${calls.filter((item) => item === method).length}` };
      return { status: "ready", method, params };
    },
  };
}

function assistantTool(name: string, args: Record<string, unknown>, index: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${index}`, name, arguments: args }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: model.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

const seenOptions: Record<string, unknown>[] = [];

function scriptedStream(script: readonly AssistantMessage[]) {
  let index = 0;
  return (async (_model: Model<Api>, _context: Context, options?: Record<string, unknown>) => {
    if (options) seenOptions.push(options);
    const message = script[Math.min(index++, script.length - 1)]!;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "toolUse", message });
    stream.end(message);
    return stream;
  }) as unknown as StreamFn;
}

describe("agent harness guard rails", () => {
  afterEach(() => vi.useRealTimers());

  it("restricts tools and bounds read_file and search", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "omni-agent-"));
    roots.project = join(tempRoot, "project");
    roots.marketplace = join(tempRoot, "marketplace");
    await mkdir(roots.project);
    await mkdir(roots.marketplace);
    await writeFile(join(roots.project, "CLAUDE.md"), "convention", "utf8");
    const calls: string[] = [];
    const tools = createJobTools({
      router: router(calls),
      grants: grants(),
      client: { name: "omni-job", version: "test" },
      methods: ["read_file", "search"],
    });
    const read = tools.find((tool) => tool.name === "read_file")!;
    expect((await read.execute("call", { root: "project", path: "CLAUDE.md" })).content[0].text).toBe("convention");
    await expect(read.execute("call", { root: "project", path: "../secret" })).rejects.toThrow();
    await expect(read.execute("call", { root: "project", path: "node_modules/pkg" })).rejects.toThrow();
    const search = tools.find((tool) => tool.name === "search")!;
    await expect(search.execute("call", { root: "project", query: "claude", limit: 51 })).rejects.toThrow();
  });

  it("uses sequential execution, never places the key in messages, and creates a preview request", async () => {
    const budget = createBudget({ logFilePath: join(tempRoot || tmpdir(), "agent-log.json") });
    const key = "secret-key-not-in-transcript";
    const calls: string[] = [];
    const harness = createJobHarness({
      connection: { preset: "anthropic", displayName: "Anthropic" },
      model,
      readKey: async () => key,
      router: router(calls),
      grants: grants(),
      budget,
      tools: ["preview_create_skill"],
      streamFn: scriptedStream([
        assistantTool(
          "omni_preview_create_skill",
          { sourceId: "personal", packageId: "plugin", name: "review", description: "Review", body: "# Review" },
          1,
        ),
        assistantTool(
          "omni_preview_create_skill",
          { sourceId: "personal", packageId: "plugin", name: "testing", description: "Testing", body: "# Testing" },
          2,
        ),
      ]),
    });
    const result = await harness.run("Compose the project.");
    expect(result.requestIds).toEqual(["request-1"]);
    expect(harness.agent.state.messages.some((message) => JSON.stringify(message).includes(key))).toBe(false);
    expect(result.toolCalls).toBe(1);
    expect(calls).toEqual(["preview_create_skill"]);
    // The key travels in the request options only, and every turn is bounded: a gateway
    // reserving the model's full 128 k window in credits refused a real run with 402.
    expect(seenOptions.every((options) => options.apiKey === key && options.maxTokens === 4_096)).toBe(true);
  });

  it("exposes a read-only skill inventory scoped to the job's granted project", async () => {
    const read = vi.fn(async () => ({ status: "ready", units: [] }));
    const tools = createJobTools({
      router: { handle: read },
      grants: grants(),
      client: { name: "test", version: "1" },
    });
    const inventory = tools.find((tool) => tool.name === "omni_skill_inventory");
    expect(inventory).toBeDefined();
    await inventory!.execute("inventory", {});
    expect(read).toHaveBeenCalledWith("skill_inventory", { projectIds: ["project-one"] }, expect.any(Object));
    await inventory!.execute("inventory-page", { cursor: "page-two", includeMarketplace: false });
    expect(read).toHaveBeenLastCalledWith(
      "skill_inventory",
      { cursor: "page-two", projectIds: ["project-one"], includeMarketplace: false },
      expect.any(Object),
    );
    await expect(inventory!.execute("inventory", { projectIds: ["other-project"] })).rejects.toThrow("granted project");
  });

  it("uses the model output cap and reports the last context estimate", async () => {
    const budget = createBudget({ logFilePath: join(tempRoot || tmpdir(), "agent-log-limited.json") });
    const limitedModel = { ...model, maxOutputTokens: 1_200 };
    const harness = createJobHarness({
      connection: { preset: "anthropic", displayName: "Anthropic" },
      model: limitedModel,
      readKey: async () => "key",
      router: router(),
      grants: grants(),
      budget,
      tools: ["preview_create_skill"],
      streamFn: scriptedStream([
        assistantTool(
          "omni_preview_create_skill",
          { sourceId: "personal", packageId: "plugin", name: "review", description: "Review", body: "# Review" },
          3,
        ),
      ]),
    });
    const result = await harness.run("Compose the project.");
    expect(seenOptions.at(-1)?.maxTokens).toBe(1_200);
    expect(result).toMatchObject({ contextWindow: 100_000, contextEstimate: expect.any(Number) });
    expect(result.contextEstimate).toBeGreaterThan(0);
  });

  it("turns a provider length stop into the canonical context exhaustion reason", async () => {
    const budget = createBudget({ logFilePath: join(tempRoot || tmpdir(), "agent-log-context.json") });
    const lengthMessage = { ...assistantTool("none", {}, 4), content: [], stopReason: "length" as const };
    const harness = createJobHarness({
      connection: { preset: "anthropic", displayName: "Anthropic" },
      model,
      readKey: async () => "key",
      router: router(),
      grants: grants(),
      budget,
      streamFn: scriptedStream([lengthMessage]),
    });
    const result = await harness.run("Compose the project.");
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/^Context exhausted: ~\d+ k tokens for a 100 k window after 1 turns\.$/);
    expect(result.reason).not.toContain("provider");
  });
});
