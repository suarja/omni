import { join } from "node:path";
import { expect, it } from "vitest";

import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import type { SkillPreview } from "../../src/shared/skill-management-ipc";
import { projectSkill, registerOperations } from "./skill-adoption-fixture";
import { managedFixture } from "./skill-resolution-fixture";

const detachIntent = (fixture: Awaited<ReturnType<typeof managedFixture>>) => ({
  kind: "reconcile" as const,
  request: {
    choice: "detach-managed" as const,
    skillId: fixture.skillId,
    locations: [{ projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill }] as const,
  },
});

function authorization(preview: SkillPreview) {
  if (preview.status !== "ready") throw new Error("Expected a ready preview.");
  return {
    kind: "desktop" as const,
    effectFingerprint: preview.effectFingerprint,
    approvedAt: new Date().toISOString(),
  };
}

it("blocks MCP forward and inverse detachment previews and rejects a non-desktop inverse journal", async () => {
  const fixture = await managedFixture();
  const operations = await registerOperations(fixture);
  const service = operations.skillManagement;
  const detached = await service.preview(detachIntent(fixture), { kind: "desktop" });
  expect(detached.status).toBe("ready");
  if (detached.status !== "ready") return;
  const detachedResult = await service.apply(detached.intentId, authorization(detached));
  expect(detachedResult.status).toBe("applied");
  const childId = detachedResult.receipts?.[0]?.operationId;
  if (!childId) throw new Error("The detached child receipt is unavailable.");

  const forward = await service.preview(detachIntent(fixture), { kind: "mcp", requestId: "mcp-forward" });
  expect(forward.status).toBe("blocked");
  if (forward.status === "blocked") expect(forward.details.map(({ code }) => code)).toContain("detachment-local-only");

  for (const operationId of [detached.intentId, childId]) {
    const inverse = await service.preview({ kind: "restore", operationId }, { kind: "mcp", requestId: operationId });
    expect(inverse.status).toBe("blocked");
    if (inverse.status === "blocked")
      expect(inverse.details.map(({ code }) => code)).toContain("detachment-local-only");
  }

  const inverse = await service.preview({ kind: "restore", operationId: detached.intentId }, { kind: "desktop" });
  expect(inverse.status).toBe("ready");
  if (inverse.status !== "ready") return;
  const journal = createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations"));
  const saved = await journal.read(inverse.intentId);
  if (saved.status !== "ready") throw new Error("The inverse journal is unavailable.");
  await journal.write({ ...saved.record, actor: { kind: "mcp", requestId: "forged-inverse" } });

  const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
  const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  const relationshipsBefore = await relationships.read();
  const bindingsBefore = await bindings.read();
  expect(relationshipsBefore.status).toBe("ready");
  expect(bindingsBefore.status).toBe("ready");

  await expect(service.apply(inverse.intentId, authorization(inverse))).rejects.toThrow("desktop-only");
  expect(await relationships.read()).toEqual(relationshipsBefore);
  expect(await bindings.read()).toEqual(bindingsBefore);
});

it("blocks MCP preview of an interrupted stop-management recovery", async () => {
  const fixture = await managedFixture();
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  let progressCount = 0;
  const operations = registerOperationsIpcHandlers(() => undefined, fixture.registry, {
    userDataPath: fixture.userDataPath,
    applyRestore: fixture.applyRestore,
    bindings: fixture.bindings,
    now: Date.now,
    onSkillProgress: () => {
      progressCount += 1;
      if (progressCount === 2) throw new Error("Injected interruption after durable progress.");
    },
  });
  await operations.skillManagement.initialize();
  const detached = await operations.skillManagement.preview(detachIntent(fixture), { kind: "desktop" });
  expect(detached.status).toBe("ready");
  if (detached.status !== "ready") return;
  expect((await operations.skillManagement.apply(detached.intentId, authorization(detached))).status).toBe(
    "recovery-required",
  );

  const recovery = await operations.skillManagement.preview(
    { kind: "restore", operationId: detached.intentId },
    { kind: "mcp", requestId: "mcp-recovery" },
  );
  expect(recovery.status).toBe("blocked");
  if (recovery.status === "blocked")
    expect(recovery.details.map(({ code }) => code)).toContain("detachment-local-only");
});

it("blocks MCP preview of an interrupted inverse journal", async () => {
  const fixture = await managedFixture();
  const initial = await registerOperations(fixture);
  const detached = await initial.skillManagement.preview(detachIntent(fixture), { kind: "desktop" });
  expect(detached.status).toBe("ready");
  if (detached.status !== "ready") return;
  expect((await initial.skillManagement.apply(detached.intentId, authorization(detached))).status).toBe("applied");

  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  let progressCount = 0;
  const operations = registerOperationsIpcHandlers(() => undefined, fixture.registry, {
    userDataPath: fixture.userDataPath,
    applyRestore: fixture.applyRestore,
    bindings: fixture.bindings,
    onSkillProgress: () => {
      progressCount += 1;
      if (progressCount === 2) throw new Error("Injected interruption after inverse acknowledgment.");
    },
  });
  await operations.skillManagement.initialize();
  const inverse = await operations.skillManagement.preview(
    { kind: "restore", operationId: detached.intentId },
    { kind: "desktop" },
  );
  expect(inverse.status).toBe("ready");
  if (inverse.status !== "ready") return;
  expect((await operations.skillManagement.apply(inverse.intentId, authorization(inverse))).status).toBe(
    "recovery-required",
  );

  const recovery = await operations.skillManagement.preview(
    { kind: "restore", operationId: inverse.intentId },
    { kind: "mcp", requestId: "mcp-interrupted-inverse" },
  );
  expect(recovery.status).toBe("blocked");
  if (recovery.status === "blocked")
    expect(recovery.details.map(({ code }) => code)).toContain("detachment-local-only");
});
