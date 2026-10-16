import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createOmniServer } from "../../packages/omni-mcp/src/server";
import { createGatewayClient } from "../../packages/omni-mcp/src/gateway-client";
import type { GatewayClientLike } from "../../packages/omni-mcp/src/gateway-client";
import { configText } from "../../packages/omni-mcp/src/cli";
import { createAgentGateway, type AgentRouter } from "../../src/main/agent-gateway/server";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";

const roots: string[] = [];
const gateways: Array<{ stop(): Promise<void> }> = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join("/private/tmp", "omni-mcp-server-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function textResult(result: unknown): Record<string, unknown> {
  const content =
    typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)
      ? result.content
      : [];
  const textItem = content.find(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string",
  );
  const text = typeof textItem === "object" && textItem !== null && "text" in textItem ? textItem.text : undefined;
  if (!text) throw new Error("The MCP result did not contain text.");
  return JSON.parse(text) as Record<string, unknown>;
}

async function connectServer(gatewayClient: GatewayClientLike): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createOmniServer(gatewayClient);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1" });
  await client.connect(clientTransport);
  return { client, close: async () => Promise.all([client.close(), server.close()]).then(() => undefined) };
}

async function startedGateway(userDataPath: string, router: AgentRouter) {
  await mkdir(join(userDataPath, "omni"), { recursive: true });
  await writeFile(join(userDataPath, "omni", "agent-token"), `${"a".repeat(64)}\n`);
  const gateway = createAgentGateway({
    userDataPath,
    router,
    tokenManager: {
      ensure: async () => "a".repeat(64),
      rotate: async () => "a".repeat(64),
      tokenCreatedAt: async () => new Date(0).toISOString(),
    },
  });
  gateways.push(gateway);
  await gateway.start();
  return gateway;
}

describe("Omni MCP server", () => {
  it("exposes read tools and a preview/apply approval loop over the real gateway", async () => {
    const userDataPath = await root();
    const requests = createAgentRequestsStore(join(userDataPath, "omni", "agent-requests.json"));
    const plan = {
      planId: "plan-1",
      kind: "make-compatible",
      displayTarget: "claude-plugins",
      actions: [{ kind: "write-file", relativePath: "codex.json" }],
      git: { mode: "commit", warnings: [] },
    } as const;
    const router: AgentRouter = {
      handle: async (method, params) => {
        if (method === "status")
          return { status: "ready", appVersion: "1.0.0", personalMarketplace: null, projects: [] };
        if (method === "list_marketplace")
          return {
            status: "ready",
            marketplace: { id: "personal", name: "Personal" },
            packages: [],
            remotePackages: [],
          };
        if (method === "preview_make_compatible") {
          const created = await requests.create({
            request: { kind: "make-compatible", sourceId: "claude-plugins", harness: "codex" },
            plan,
          });
          return { requestId: created.requestId, plan, approval: "omni" };
        }
        if (method === "apply") {
          const request = await requests.wait(String((params as { requestId: string }).requestId), 10_000);
          if (!request || request.status !== "approved") return { status: "expired" };
          return {
            status: "applied",
            receipt: {
              operationId: request.receiptId,
              kind: "make-compatible",
              status: "applied",
              appliedAt: "2026-09-14T00:00:00.000Z",
              displayTarget: "claude-plugins",
              actions: [{ kind: "write-file", relativePath: "codex.json", status: "applied" }],
              git: { mode: "commit", commit: "d1aeb9c" },
              registered: null,
              provenance: { approval: "omni", agent: "codex" },
            },
          };
        }
        throw new Error(`Unexpected method ${method}`);
      },
    };
    await startedGateway(userDataPath, router);
    const gatewayClient = createGatewayClient({ userDataPath, version: "test" });
    const connected = await connectServer(gatewayClient);

    const status = await connected.client.callTool({ name: "omni_status", arguments: {} });
    expect(textResult(status)).toMatchObject({ status: "ready", appVersion: "1.0.0" });
    const marketplace = await connected.client.callTool({ name: "omni_list_marketplace", arguments: {} });
    expect(textResult(marketplace)).toMatchObject({ marketplace: { name: "Personal" } });
    const preview = await connected.client.callTool({
      name: "omni_preview_make_compatible",
      arguments: { sourceId: "claude-plugins", harness: "codex" },
    });
    const previewValue = textResult(preview);
    expect(previewValue).toMatchObject({
      requestId: expect.any(String),
      plan,
      approval: "omni",
      summary: expect.stringContaining("1 file"),
    });
    const requestId = String(previewValue.requestId);
    const applying = connected.client.callTool({ name: "omni_apply", arguments: { requestId } });
    const stored = await requests.get(requestId);
    if (!stored) throw new Error("Preview request was not stored.");
    await requests.resolve(requestId, "operation-1");
    const applied = await applying;
    expect(textResult(applied)).toMatchObject({ status: "applied", receipt: { git: { commit: "d1aeb9c" } } });

    await connected.close();
    await gatewayClient.close();
  });

  it("returns a normal unavailable result when the desktop is not running", async () => {
    const gatewayClient = createGatewayClient({ userDataPath: await root(), version: "test" });
    const connected = await connectServer(gatewayClient);

    const result = await connected.client.callTool({ name: "omni_status", arguments: {} });
    expect(textResult(result)).toEqual({
      status: "app-not-running",
      message: "Open Omni Desktop to use the Omni tools.",
    });

    await connected.close();
    await gatewayClient.close();
  });

  it("registers every tool with strict inputs and forwards gateway methods", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway: GatewayClientLike = {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method.startsWith("preview_"))
          return {
            ok: true,
            result: {
              requestId: "request-1",
              plan: {
                planId: "plan-1",
                kind: "write-skill",
                displayTarget: "claude-plugins",
                actions: [],
                git: { mode: "commit", warnings: [] },
              },
              approval: "conversation",
            },
          };
        if (method === "apply") return { ok: true, result: { status: "declined" } };
        return { ok: true, result: { status: "ready", method } };
      },
      close: async () => undefined,
    };
    const connected = await connectServer(gateway);
    const tools = await connected.client.listTools();
    const noArgumentTools = new Set([
      "omni_bootstrap_status",
      "omni_status",
      "omni_list_marketplace",
      "omni_list_external_library",
    ]);
    for (const tool of tools.tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      const properties = tool.inputSchema.properties ?? {};
      if (noArgumentTools.has(tool.name)) expect(Object.keys(properties), tool.name).toEqual([]);
      else expect(Object.keys(properties), tool.name).not.toEqual([]);
    }
    const createSkillSchema = tools.tools.find((tool) => tool.name === "omni_preview_create_skill")?.inputSchema;
    expect(createSkillSchema?.properties).toMatchObject({
      sourceId: expect.any(Object),
      packageId: expect.any(Object),
      newPackage: {
        type: "object",
        properties: expect.objectContaining({ name: expect.any(Object), description: expect.any(Object) }),
      },
      folderName: expect.any(Object),
      files: { type: "array" },
    });
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "omni_bootstrap_status",
      "omni_status",
      "omni_list_marketplace",
      "omni_find_skill",
      "omni_skill_inventory",
      "omni_list_external_library",
      "omni_preview_install_external",
      "omni_list_project_assets",
      "omni_drift_report",
      "omni_receipt",
      "omni_stack_profile",
      "omni_catalog_search",
      "omni_suggest",
      "omni_session",
      "omni_preview_register_project",
      "omni_preview_publish",
      "omni_preview_capture",
      "omni_preview_make_compatible",
      "omni_preview_assign",
      "omni_preview_remove",
      "omni_preview_restore",
      "omni_preview_create_skill",
      "omni_preview_update_skill",
      "omni_preview_sync_skill",
      "omni_apply",
    ]);
    for (const tool of tools.tools.filter(
      (tool) => tool.name.startsWith("omni_preview_") || tool.name === "omni_apply",
    )) {
      expect(tool.description).toContain("Approval happens in Omni Desktop: <reason>.");
      expect(tool.description).toContain("same requestId; the request does not expire");
    }
    await connected.client.callTool({ name: "omni_bootstrap_status", arguments: {} });
    await connected.client.callTool({ name: "omni_status", arguments: {} });
    await connected.client.callTool({ name: "omni_list_marketplace", arguments: {} });
    await connected.client.callTool({ name: "omni_find_skill", arguments: { query: "capture" } });
    await connected.client.callTool({
      name: "omni_skill_inventory",
      arguments: { projectIds: ["project-1"], includeMarketplace: false },
    });
    await connected.client.callTool({ name: "omni_list_project_assets", arguments: { projectId: "project-1" } });
    await connected.client.callTool({ name: "omni_drift_report", arguments: {} });
    await connected.client.callTool({ name: "omni_receipt", arguments: { operationId: "operation-1" } });
    const invalidReceipt = await connected.client.callTool({ name: "omni_receipt", arguments: {} });
    expect(invalidReceipt.isError).toBe(true);
    expect(JSON.stringify(invalidReceipt)).toContain("Provide operationId or requestId.");
    const ambiguousReceipt = await connected.client.callTool({
      name: "omni_receipt",
      arguments: { operationId: "operation-1", requestId: "request-1" },
    });
    expect(ambiguousReceipt.isError).toBe(true);
    expect(JSON.stringify(ambiguousReceipt)).toContain("Provide operationId or requestId.");
    await connected.client.callTool({ name: "omni_stack_profile", arguments: { projectId: "project-1" } });
    await connected.client.callTool({ name: "omni_catalog_search", arguments: { query: "react" } });
    await connected.client.callTool({ name: "omni_suggest", arguments: { projectId: "project-1" } });
    await connected.client.callTool({ name: "omni_session", arguments: { sessionId: "claude-code:session-1" } });
    await connected.client.callTool({
      name: "omni_preview_capture",
      arguments: { projectId: "project-1", relativePath: "skills/example/SKILL.md", target: { packageId: "pkg" } },
    });
    await connected.client.callTool({
      name: "omni_preview_make_compatible",
      arguments: { sourceId: "source-1", harness: "codex", askInOmni: true },
    });
    await connected.client.callTool({
      name: "omni_preview_assign",
      arguments: {
        artifactPath: "skills/example",
        sourceId: "source-1",
        packageId: "pkg",
        projectIds: ["project-1"],
        harnesses: ["codex"],
      },
    });
    await connected.client.callTool({
      name: "omni_preview_remove",
      arguments: { bindingIds: ["binding-1"] },
    });
    await connected.client.callTool({
      name: "omni_preview_restore",
      arguments: { operationId: "operation-1" },
    });
    await connected.client.callTool({
      name: "omni_preview_create_skill",
      arguments: {
        sourceId: "source-1",
        packageId: "pkg",
        folderName: "example-skill",
        files: [
          {
            path: "SKILL.md",
            content: "---\nname: example-skill\ndescription: Use when capturing examples.\n---\n\n# Example\n",
          },
        ],
      },
    });
    const invalidCreateSkill = await connected.client.callTool({
      name: "omni_preview_create_skill",
      arguments: {
        sourceId: "source-1",
        folderName: "example-skill",
        files: [{ path: "SKILL.md", content: "# Example\n" }],
      },
    });
    expect(invalidCreateSkill.isError).toBe(true);
    expect(JSON.stringify(invalidCreateSkill)).toContain("Choose exactly one packageId or newPackage.");
    const ambiguousCreateSkill = await connected.client.callTool({
      name: "omni_preview_create_skill",
      arguments: {
        sourceId: "source-1",
        packageId: "packages/existing",
        newPackage: { name: "new-package", description: "A new package." },
        folderName: "example-skill",
        files: [{ path: "SKILL.md", content: "# Example\n" }],
      },
    });
    expect(ambiguousCreateSkill.isError).toBe(true);
    expect(JSON.stringify(ambiguousCreateSkill)).toContain("Choose exactly one packageId or newPackage.");
    await connected.client.callTool({
      name: "omni_preview_update_skill",
      arguments: {
        sourceId: "source-1",
        packageId: "pkg",
        folderName: "example-skill",
        files: [{ path: "SKILL.md", content: "# Updated\n" }],
      },
    });
    await connected.client.callTool({
      name: "omni_preview_update_skill",
      arguments: {
        sourceId: "source-1",
        packageId: "pkg",
        folderName: "example-skill",
        files: [{ path: "SKILL.md", content: "# Source only" }],
        sourceOnly: true,
      },
    });
    await connected.client.callTool({
      name: "omni_preview_sync_skill",
      arguments: {
        sourceId: "source-1",
        packageId: "pkg",
        artifactPath: "skills/example-skill",
        projectIds: ["project-1"],
        askInOmni: true,
      },
    });
    expect(calls.at(-2)?.params).toMatchObject({ sourceOnly: true });
    expect(calls.at(-1)).toEqual({
      method: "preview_sync_skill",
      params: {
        sourceId: "source-1",
        packageId: "pkg",
        artifactPath: "skills/example-skill",
        projectIds: ["project-1"],
        askInOmni: true,
      },
    });
    const invalid = await connected.client.callTool({
      name: "omni_preview_sync_skill",
      arguments: { sourceId: "source-1", packageId: "pkg", artifactPath: "skills/example", skillId: "forbidden" },
    });
    expect(invalid.isError).toBe(true);
    const applied = await connected.client.callTool({ name: "omni_apply", arguments: { requestId: "request-1" } });
    expect(textResult(applied)).toMatchObject({ status: "declined", message: "Declined in Omni." });
    expect(calls.map((call) => call.method)).toEqual([
      "status",
      "status",
      "list_marketplace",
      "find_skill",
      "skill_inventory",
      "list_project_assets",
      "drift_report",
      "receipt",
      "stack_profile",
      "catalog_search",
      "suggest",
      "session",
      "preview_capture",
      "preview_make_compatible",
      "preview_assign",
      "preview_remove",
      "preview_restore",
      "preview_create_skill",
      "preview_update_skill",
      "preview_update_skill",
      "preview_sync_skill",
      "apply",
    ]);
    expect(calls.at(-1)?.params).toEqual({ requestId: "request-1", waitMs: 45000 });
    expect(calls[14]?.params).toMatchObject({ harnesses: ["codex"] });
    expect(calls[17]?.params).toMatchObject({
      name: "example-skill",
      description: "Use when capturing examples.",
      body: "# Example\n",
    });
    expect(calls[13]?.params).toMatchObject({ askInOmni: true });
    await connected.close();
  });

  it("attaches a message summary to the four new read tools, without overwriting an unavailable result", async () => {
    const gateway: GatewayClientLike = {
      request: async (method) => {
        if (method === "stack_profile")
          return {
            ok: true,
            result: {
              status: "ready",
              profile: {
                tags: [{ id: "next", label: "Next.js", evidence: ["package.json dependency next@16"] }],
                languages: [],
                harnesses: [],
                computedAt: "2026-09-14T00:00:00.000Z",
                treeHash: "a".repeat(64),
              },
              cached: true,
            },
          };
        if (method === "catalog_search") return { ok: true, result: { status: "ready", results: [] } };
        if (method === "suggest")
          return {
            ok: true,
            result: {
              status: "ready",
              results: [
                {
                  name: "next-helper",
                  ownerRepo: "vercel-labs/skills",
                  skill: "next-helper",
                  tags: ["next"],
                  installs: 712_000,
                  official: true,
                  inMarketplace: false,
                  why: ["next"],
                  alreadyInProject: false,
                },
              ],
            },
          };
        if (method === "session")
          return {
            ok: false,
            unavailable: { status: "app-not-running", message: "Open Omni Desktop to use the Omni tools." },
          };
        throw new Error(`Unexpected method ${method}`);
      },
      close: async () => undefined,
    };
    const connected = await connectServer(gateway);

    const stackProfile = await connected.client.callTool({
      name: "omni_stack_profile",
      arguments: { projectId: "project-1" },
    });
    expect(textResult(stackProfile)).toMatchObject({ message: expect.stringContaining("Next.js") });

    const catalogSearch = await connected.client.callTool({ name: "omni_catalog_search", arguments: {} });
    expect(textResult(catalogSearch)).toMatchObject({ message: expect.stringContaining("0 matches") });

    const suggest = await connected.client.callTool({ name: "omni_suggest", arguments: { projectId: "project-1" } });
    expect(textResult(suggest)).toMatchObject({ message: expect.stringContaining("next") });

    const session = await connected.client.callTool({
      name: "omni_session",
      arguments: { sessionId: "claude-code:session-1" },
    });
    expect(textResult(session)).toEqual({
      status: "app-not-running",
      message: "Open Omni Desktop to use the Omni tools.",
    });
    await connected.close();
  });

  it("passes through a gateway not-available error as a normal result", async () => {
    const gateway: GatewayClientLike = {
      request: async () => ({ ok: false, error: { code: "not-available", message: "Brief 26b is not installed." } }),
      close: async () => undefined,
    };
    const connected = await connectServer(gateway);

    const result = await connected.client.callTool({
      name: "omni_preview_update_skill",
      arguments: {
        sourceId: "source-1",
        packageId: "pkg",
        folderName: "example-skill",
        files: [{ path: "SKILL.md", content: "# Updated\n" }],
      },
    });
    expect(textResult(result)).toEqual({ status: "not-available", message: "Brief 26b is not installed." });
    await connected.close();
  });

  it("prints the Claude and Codex configuration snippets", () => {
    expect(JSON.parse(configText("claude", "/opt/omni/cli.js"))).toEqual({
      mcpServers: {
        omni: { command: "node", args: ["/opt/omni/cli.js"], env: { OMNI_USER_DATA: expect.any(String) } },
      },
    });
    expect(configText("codex", "/opt/omni/cli.js")).toMatch(/\[mcp_servers\.omni\.env\]\nOMNI_USER_DATA = "[^"]+"\n/u);
  });
});

it("routes public publication previews and advertises mandatory Omni approval", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const connected = await connectServer({
    close: async () => undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      return {
        ok: true,
        result: {
          requestId: "publish-request",
          approval: "omni",
          approvalReason: { code: "public-publication" },
          plan: {
            planId: "publish-plan",
            kind: "publish-plugin",
            displayTarget: "plugins/demo",
            actions: [],
            git: { mode: "commit", warnings: [] },
          },
        },
      };
    },
  });
  try {
    const tools = await connected.client.listTools();
    expect(tools.tools.find((tool) => tool.name === "omni_preview_publish")?.description).toContain("always waits");
    const result = await connected.client.callTool({
      name: "omni_preview_publish",
      arguments: { pluginId: "demo", storefrontId: "storefront", conflictChoices: { "guide.md": "keep-storefront" } },
    });
    expect(textResult(result)).toMatchObject({
      requestId: "publish-request",
      approval: "omni",
      approvalReason: { code: "public-publication" },
    });
    expect(calls).toEqual([
      {
        method: "preview_publish",
        params: { pluginId: "demo", storefrontId: "storefront", conflictChoices: { "guide.md": "keep-storefront" } },
      },
    ]);
  } finally {
    await connected.close();
  }
});
