import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createOmniServer } from "../../packages/omni-mcp/src/server";
import type { GatewayClientLike } from "../../packages/omni-mcp/src/gateway-client";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createOperationStore } from "../../src/main/operation-store";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import {
  SKILL_MANAGEMENT_IPC_CHANNELS,
  type SkillPreview,
  type SkillResult,
} from "../../src/shared/skill-management-ipc";
import { handlers, setup } from "../ipc/apply-ipc-helpers";
import type { GitCli } from "../../src/main/git-cli";

const NOW = Date.parse("2026-10-07T10:00:00.000Z");

function textResult(result: unknown): Record<string, unknown> {
  const content =
    typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)
      ? result.content
      : [];
  const item = content.find((entry: unknown) => typeof entry === "object" && entry !== null && "text" in entry);
  if (typeof item !== "object" || item === null || !("text" in item) || typeof item.text !== "string")
    throw new Error("The MCP response did not include text.");
  return JSON.parse(item.text) as Record<string, unknown>;
}

const git: GitCli = {
  remoteUrl: async () => undefined,
  push: async () => {
    throw new Error("Unexpected push in this test.");
  },
  isGitAvailable: async () => true,
  enclosingRepository: async () => ({ status: "none" }),
  initAndCommit: async () => ({ status: "committed", commit: "a".repeat(40) }),
  commitAll: async () => ({ status: "committed", commit: "b".repeat(40) }),
  hasChanges: async () => false,
  isRepositoryRoot: async () => false,
  headCommit: async () => undefined,
};

describe("shared skill management journey", () => {
  it("reopens an unchanged MCP creation later, assigns in Desktop, removes through MCP, and restores in Desktop", async () => {
    let currentTime = NOW;
    const fixture = await setup({ commitChanges: false });
    await mkdir(join(fixture.sourceRoot, "packages/tools/.codex-plugin"), { recursive: true });
    await writeFile(
      join(fixture.sourceRoot, "packages/tools/.codex-plugin/plugin.json"),
      JSON.stringify({ name: "tools", version: "1.0.0", description: "Integration fixture" }),
      "utf8",
    );
    await mkdir(join(fixture.sourceRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(fixture.sourceRoot, ".claude-plugin/marketplace.json"),
      JSON.stringify({ name: "Personal", plugins: [{ name: "tools", source: "./packages/tools" }] }),
      "utf8",
    );
    const requests = createAgentRequestsStore(
      join(fixture.userDataPath, "omni", "agent-requests.json"),
      () => currentTime,
    );
    const settingsStore = createSettingsStore(settingsFilePath(fixture.userDataPath));
    const settings = await settingsStore.read();
    await settingsStore.set({
      commitChanges: false,
      agents: {
        approval: { personalMarketplace: "conversation", projects: "conversation" },
        guard: settings.agents.guard,
      },
      ai: settings.ai,
      features: settings.features,
      externalLibrary: settings.externalLibrary,
    });
    const operationStore = createOperationStore(join(fixture.userDataPath, "omni", "operations.json"));
    const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
    const operations = registerOperationsIpcHandlers(() => undefined, fixture.registry, {
      userDataPath: fixture.userDataPath,
      operationStore,
      settingsStore,
      bindings: fixture.bindings,
      applyRestore: fixture.applyRestore,
      agentRequests: requests,
      gitCli: git,
      now: () => currentTime,
    });
    await operations.skillManagement.initialize();
    const { createAgentRouter } = await import("../../src/main/agent-gateway/router");
    const router = createAgentRouter({
      userDataPath: fixture.userDataPath,
      registry: fixture.registry,
      bindings: fixture.bindings,
      operations,
      requests,
      operationStore,
      settingsStore,
      now: () => currentTime,
    });
    const gateway: GatewayClientLike = {
      request: async (method, params) => {
        try {
          return {
            ok: true,
            result: await router.handle(method, params, {
              name: "integration",
              version: "1",
              harness: "codex",
              sessionName: "integration-session",
            }),
          };
        } catch (error: unknown) {
          return {
            ok: false,
            error: { code: "operation-failed", message: error instanceof Error ? error.message : "Operation failed." },
          };
        }
      },
      close: async () => undefined,
    };
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createOmniServer(gateway);
    await server.connect(serverTransport);
    const client = new Client({ name: "integration", version: "1" });
    await client.connect(clientTransport);

    try {
      const createPreview = textResult(
        await client.callTool({
          name: "omni_preview_create_skill",
          arguments: {
            sourceId: fixture.source.id,
            packageId: "packages/tools",
            folderName: "s03-integration",
            files: [
              {
                path: "SKILL.md",
                content:
                  "---\nname: s03-integration\ndescription: Use for the shared skill journey.\n---\n\n# Integration\n",
              },
            ],
          },
        }),
      );
      expect(createPreview).toMatchObject({
        approval: "conversation",
        sourceOnly: true,
        summary: expect.stringContaining("no project assignment"),
      });
      currentTime += 60_000;
      const reopened = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.refresh)!(
        {},
        {
          intentId: createPreview.intentId,
          requestId: createPreview.requestId,
        },
      )) as SkillPreview;
      expect(reopened).toMatchObject({
        status: "ready",
        effectFingerprint: (createPreview.skillPreview as SkillPreview & { status: "ready" }).effectFingerprint,
      });
      const createResult = textResult(
        await client.callTool({ name: "omni_apply", arguments: { requestId: createPreview.requestId } }),
      );
      expect(createResult).toMatchObject({ status: "applied" });
      expect(JSON.parse(await readFile(join(fixture.sourceRoot, "omni.marketplace.json"), "utf8"))).toMatchObject({
        createdAt: new Date(NOW).toISOString(),
      });
      const created = (await operations.skillManagement.readResult(String(createPreview.intentId))) as
        SkillResult | undefined;
      expect(created).toMatchObject({ status: "applied", source: { status: "created", sourceId: fixture.source.id } });

      const createdHistory = await operationStore.read();
      expect(createdHistory).toMatchObject({
        status: "ready",
        receipts: expect.arrayContaining([
          expect.objectContaining({
            operationId: created!.operationId,
            kind: "skill-management",
            actions: [],
            children: created!.receiptIds,
            skillManagement: expect.objectContaining({
              status: "applied",
              source: { status: "created", sourceId: fixture.source.id },
            }),
          }),
        ]),
      });

      const receiptLookup = textResult(
        await client.callTool({ name: "omni_receipt", arguments: { requestId: createPreview.requestId } }),
      );
      expect(receiptLookup).toMatchObject({
        status: "found",
        receipt: { operationId: created!.operationId, kind: "skill-management" },
      });

      const assignmentPreview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
        {},
        {
          intent: {
            kind: "assign",
            sourceId: fixture.source.id,
            packageId: "packages/tools",
            artifactPath: "skills/s03-integration",
            targets: [{ projectId: fixture.project.id, harnessIds: ["codex"] }],
          },
        },
      )) as SkillPreview;
      expect(assignmentPreview.status).toBe("ready");
      if (assignmentPreview.status !== "ready") throw new Error("Desktop assignment preview was not ready.");
      const assignmentResult = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
        {},
        {
          intentId: assignmentPreview.intentId,
          effectFingerprint: assignmentPreview.effectFingerprint,
        },
      )) as SkillResult;
      expect(assignmentResult).toMatchObject({
        status: "applied",
        targets: [{ projectId: fixture.project.id, harnessId: "codex", status: "applied" }],
      });
      const sameAssignment = await operations.skillManagement.preview(
        {
          kind: "assign",
          sourceId: fixture.source.id,
          packageId: "packages/tools",
          artifactPath: "skills/s03-integration",
          targets: [{ projectId: fixture.project.id, harnessIds: ["codex"] }],
        },
        { kind: "desktop" },
      );
      if (sameAssignment.status !== "ready") throw new Error("Expected the no-op assignment preview.");
      const noOp = await operations.skillManagement.apply(sameAssignment.intentId, {
        kind: "desktop",
        effectFingerprint: sameAssignment.effectFingerprint,
        approvedAt: new Date(NOW).toISOString(),
      });
      expect(noOp.status).toBe("no-op");
      expect(await operationStore.read()).toMatchObject({
        status: "ready",
        receipts: expect.arrayContaining([
          expect.objectContaining({
            operationId: noOp.operationId,
            children: [],
            skillManagement: expect.objectContaining({ status: "no-op" }),
          }),
        ]),
      });

      const assignedBindings = await fixture.bindings.readBindings();
      expect(assignedBindings.status).toBe("ready");
      if (assignedBindings.status !== "ready") throw new Error("Desktop assignment binding was unavailable.");
      const binding = assignedBindings.bindings.find((item) => item.artifactPath === "skills/s03-integration");
      if (!binding) throw new Error("Desktop assignment did not persist its binding.");

      const removePreview = textResult(
        await client.callTool({ name: "omni_preview_remove", arguments: { bindingIds: [binding.bindingId] } }),
      );
      expect(removePreview).toMatchObject({
        approval: "conversation",
        summary: expect.stringContaining("managed use"),
      });
      const removeResult = textResult(
        await client.callTool({ name: "omni_apply", arguments: { requestId: removePreview.requestId } }),
      );
      expect(removeResult).toMatchObject({ status: "applied" });
      const removed = (await operations.skillManagement.readResult(String(removePreview.intentId))) as
        SkillResult | undefined;
      expect(removed).toMatchObject({ status: "applied", targets: [{ status: "removed" }] });
      const removalReceiptId = removed?.receiptIds[0];
      if (!removalReceiptId) throw new Error("MCP removal did not record an operation receipt.");

      const restorePreview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
        {},
        {
          intent: { kind: "restore", operationId: removed!.operationId },
        },
      )) as SkillPreview;
      expect(restorePreview.status).toBe("ready");
      if (restorePreview.status !== "ready") throw new Error("Desktop restore preview was not ready.");
      const restoreResult = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
        {},
        {
          intentId: restorePreview.intentId,
          effectFingerprint: restorePreview.effectFingerprint,
        },
      )) as SkillResult;
      expect(restoreResult).toMatchObject({
        status: "restored",
        targets: [{ projectId: fixture.project.id, status: "restored" }],
      });
      expect(await fixture.bindings.readBindings()).toMatchObject({
        status: "ready",
        bindings: [expect.objectContaining({ bindingId: binding.bindingId })],
      });
      expect(await operations.skillManagement.readResult(removed!.operationId)).toMatchObject({
        status: "restored",
        targets: [{ status: "restored" }],
      });
      const restoredParent = textResult(
        await client.callTool({ name: "omni_receipt", arguments: { requestId: removePreview.requestId } }),
      );
      expect(restoredParent).toMatchObject({
        status: "found",
        receipt: { restored: true, skillManagement: { status: "restored" } },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
