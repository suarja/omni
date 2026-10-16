import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { parseAgentJobListResponse } from "../../src/shared/agent-jobs-ipc";
import { describe, expect, it, vi } from "vitest";

import { createAgentJobRunner } from "../../src/main/agents/runner";
import { createBudget } from "../../src/main/inference/budget";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
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

function registry(): RegistryIpcServices {
  return {
    get: (handle: string) =>
      handle === "project-grant"
        ? ({
            handle,
            subject: { kind: "project", id: "project-one" },
            root: "/tmp",
            device: "1",
            inode: "1",
            expiresAt: Date.now() + 60_000,
          } as never)
        : ({
            handle,
            subject: { kind: "source", id: "personal" },
            root: "/tmp",
            device: "1",
            inode: "2",
            expiresAt: Date.now() + 60_000,
          } as never),
    getGrantForEntry: async () => "market-grant",
    listRegistry: async () =>
      ({
        status: "ready",
        registry: {
          revision: 1,
          projects: [
            {
              ref: { kind: "project", id: "project-one" },
              displayName: "Project",
              displayRoot: "/tmp",
              availability: "available",
            },
          ],
          sources: [{ ref: { kind: "source", id: "personal" }, ownership: "personal", archivedAt: undefined }],
        },
      }) as never,
    issue: () => "unused",
    registerSourceByPath: async () => ({ status: "inaccessible", diagnostic: "unused" }),
    hasActivePersonalSource: async () => true,
    observeRegisteredEntry: async () => ({ status: "unavailable", diagnostic: "unused" }),
  } as unknown as RegistryIpcServices;
}

const router: AgentRouter = {
  handle: async (method) => {
    if (method === "list_marketplace")
      return { status: "ready", packages: [{ id: "plugin", name: "Plugin", artifacts: [] }] };
    if (method === "list_project_assets") return { status: "ready", managed: [], unmanaged: [] };
    if (method === "stack_profile") return { status: "ready", tags: [], languages: [], harnesses: [] };
    if (method === "suggest") return { status: "ready", results: [] };
    return { status: "ready" };
  },
};

describe("compose job runner", () => {
  it("returns unavailable before creating a job when there is no connection", async () => {
    const runner = createAgentJobRunner({
      router,
      registry: registry(),
      budget: createBudget({ logFilePath: "/tmp/omni-compose-test-log.json" }),
      getConnection: async () => undefined,
      readKey: async () => undefined,
    });
    await expect(
      runner.start({ job: "compose", projectId: "project-one", grantHandle: "project-grant" }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "Add a connection in Settings · AI.",
    });
    expect(runner.list()).toHaveLength(0);
  });

  it("keeps a model failure as a failed job without creating a preview", async () => {
    const runner = createAgentJobRunner({
      router,
      registry: registry(),
      budget: createBudget({ logFilePath: "/tmp/omni-compose-test-log-failure.json" }),
      getConnection: async () => ({ preset: "anthropic", displayName: "Anthropic" }),
      getModels: async () => [model],
      readKey: async () => "key",
      streamFn: async () => {
        throw new Error('model failed:\n  HTTP 401 from /chat/completions\n  {"error":"bad key"}');
      },
    });
    const started = await runner.start({ job: "compose", projectId: "project-one", grantHandle: "project-grant" });
    expect("jobId" in started).toBe(true);
    await vi.waitFor(() => expect(runner.list()[0]?.status).toBe("failed"));
    expect(runner.list()[0]).toMatchObject({ status: "failed", requestIds: [] });
    // The reason crosses the IPC as one bounded line (the parser refuses newlines).
    expect(runner.list()[0]?.reason).toBe('model failed: HTTP 401 from /chat/completions {"error":"bad key"}');
    expect(() => parseAgentJobListResponse({ jobs: runner.list() })).not.toThrow();
  });
});
