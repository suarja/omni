import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { bindingsFilePath, createBindingsStore } from "../../src/main/bindings-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";
import { createLegacyBindingBridge } from "../../src/main/skill-management/legacy-binding-bridge";
import { createOperationStore } from "../../src/main/operation-store";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import { handlers, setup, saveBindings } from "../ipc/apply-ipc-helpers";
import { treeDigest } from "./skill-adoption-fixture";
import { SKILL_MANAGEMENT_IPC_CHANNELS, type SkillPreview } from "../../src/shared/skill-management-ipc";

function textResult(result: unknown): any {
  const item = (result as { content: { text?: string }[] }).content.find((item) => item.text);
  if (!item?.text) throw new Error("The MCP response did not include text.");
  return JSON.parse(item.text);
}

describe("stale binding MCP reception", () => {
  it("previews forget this use through MCP, clears audit and startup evidence, and Undo restores the exact binding", async () => {
    const f = await setup({ commitChanges: false });
    await mkdir(join(f.sourceRoot, "packages/tools/.codex-plugin"), { recursive: true });
    await writeFile(
      join(f.sourceRoot, "packages/tools/.codex-plugin/plugin.json"),
      JSON.stringify({ name: "tools", version: "1.0.0", description: "Stale binding fixture" }),
    );
    await mkdir(join(f.sourceRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(f.sourceRoot, ".claude-plugin/marketplace.json"),
      JSON.stringify({ name: "Personal", plugins: [{ name: "tools", source: "./packages/tools" }] }),
    );
    await saveBindings([f.binding]);
    const requests = createAgentRequestsStore(join(f.userDataPath, "omni/agent-requests.json"));
    const settingsStore = createSettingsStore(settingsFilePath(f.userDataPath));
    const settings = await settingsStore.read();
    await settingsStore.set({
      commitChanges: false,
      ai: settings.ai,
      features: settings.features,
      externalLibrary: settings.externalLibrary,
      agents: { ...settings.agents, approval: { personalMarketplace: "conversation", projects: "conversation" } },
    });
    const operationStore = createOperationStore(join(f.userDataPath, "omni/operations.json"));
    const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
    const operations = registerOperationsIpcHandlers(() => undefined, f.registry, {
      userDataPath: f.userDataPath,
      operationStore,
      settingsStore,
      bindings: f.bindings,
      applyRestore: f.applyRestore,
      agentRequests: requests,
    });
    await operations.skillManagement.initialize();
    expect(operations.skillManagement.readLegacyBridgeDiagnostic?.()?.skippedLocations).toEqual(
      expect.arrayContaining([expect.objectContaining({ bindingIds: [f.binding.bindingId] })]),
    );
    const { createAgentRouter } = await import("../../src/main/agent-gateway/router");
    const router = createAgentRouter({
      userDataPath: f.userDataPath,
      registry: f.registry,
      bindings: f.bindings,
      operations,
      requests,
      operationStore,
      settingsStore,
      appVersion: "test",
    });
    const server = createOmniServer({
      request: async (method, params) => ({
        ok: true,
        result: await router.handle(method, params, { name: "omni-mcp", version: "test", harness: "claude-code" }),
      }),
      close: async () => undefined,
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "stale-binding-fixture", version: "1" });
    await client.connect(clientTransport);
    try {
      const inventory = async () =>
        textResult(
          await client.callTool({
            name: "omni_skill_inventory",
            arguments: { projectIds: [f.project.id], includeMarketplace: false },
          }),
        );
      expect((await inventory()).identity.staleBindings).toEqual([
        expect.objectContaining({ bindingId: f.binding.bindingId }),
      ]);
      const before = { project: await treeDigest(f.projectRoot), source: await treeDigest(f.sourceRoot) };
      const preview = textResult(
        await client.callTool({ name: "omni_preview_remove", arguments: { bindingIds: [f.binding.bindingId] } }),
      );
      expect(preview).toMatchObject({
        approval: "conversation",
        plan: {
          actions: [],
          notes: [expect.stringContaining("already gone"), expect.stringContaining("Forget this use")],
        },
        skillPreview: { status: "ready", steps: [{ files: [], bindingEffects: [{ before: f.binding }] }] },
      });
      expect(
        textResult(await client.callTool({ name: "omni_apply", arguments: { requestId: preview.requestId } })),
      ).toMatchObject({ status: "applied" });
      const removed = await operations.skillManagement.readResult(preview.intentId);
      expect(removed).toMatchObject({ status: "applied", targets: [{ status: "removed" }] });
      const child = removed!.receipts![0]!;
      expect(child).toMatchObject({ kind: "remove-binding", actions: [], files: [] });
      expect(await f.bindings.readBindings()).toMatchObject({ bindings: [] });
      expect((await inventory()).identity.staleBindings).toEqual([]);
      expect(operations.skillManagement.readLegacyBridgeDiagnostic?.()?.skippedLocations).toEqual([]);
      const coldBridge = createLegacyBindingBridge({
        registry: f.registry,
        bindings: createBindingsStore(bindingsFilePath(f.userDataPath)),
        relationships: createSkillRelationshipStore(join(f.userDataPath, "omni/skill-relationships.json")),
        bases: createSkillBaseStore(f.userDataPath),
        operationStore,
      });
      await coldBridge.run();
      expect(coldBridge.readDiagnostic()?.skippedLocations).toEqual([]);
      expect(await treeDigest(f.projectRoot)).toEqual(before.project);
      expect(await treeDigest(f.sourceRoot)).toEqual(before.source);
      // Undo reviews the public parent receipt through the existing Desktop restore boundary.
      const restore = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
        {},
        { intent: { kind: "restore", operationId: removed!.operationId } },
      )) as SkillPreview;
      expect(restore.status).toBe("ready");
      if (restore.status !== "ready") throw new Error("Expected the binding-only receipt to support Undo.");
      expect(restore.steps.every((step) => step.files.length === 0 && step.plan.actions.length === 0)).toBe(true);
      expect(
        await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
          {},
          { intentId: restore.intentId, effectFingerprint: restore.effectFingerprint },
        ),
      ).toMatchObject({ status: "restored", targets: [{ status: "restored" }] });
      expect(await f.bindings.readBindings()).toMatchObject({ bindings: [f.binding] });
      expect((await inventory()).identity.staleBindings).toEqual([
        expect.objectContaining({ bindingId: f.binding.bindingId }),
      ]);
      expect(operations.skillManagement.readLegacyBridgeDiagnostic?.()?.skippedLocations).toEqual(
        expect.arrayContaining([expect.objectContaining({ bindingIds: [f.binding.bindingId] })]),
      );
      expect(await treeDigest(f.projectRoot)).toEqual(before.project);
      expect(await treeDigest(f.sourceRoot)).toEqual(before.source);
    } finally {
      await client.close();
      await server.close();
    }
  }, 60_000);
});
