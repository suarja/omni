import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handlers } from "../ipc/apply-ipc-helpers";
import type { OperationStore } from "../../src/main/operation-store";
import {
  seedFixture,
  observedSkillId,
  registerOperations,
  sourcePackage,
  sourceSkill,
  projectSkill,
  treeDigest,
} from "./skill-adoption-fixture";

afterEach(() => vi.resetModules());

function captureIntent(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  skillId: string,
  folderPath = projectSkill,
  skillKey = "captured-demo",
) {
  return {
    kind: "reconcile",
    request: {
      choice: "keep-variant",
      skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath }],
      destination: { sourceId: fixture.source.id, packageId: sourcePackage, skillKey },
    },
  };
}

describe("personal skill variant capture", () => {
  it("captures complete project bytes, reads origin, and restores after reinitialization", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    await mkdir(join(fixture.projectRoot, projectSkill, "assets"));
    await writeFile(join(fixture.projectRoot, projectSkill, "assets/first.bin"), Buffer.from([8, 0, 2]));
    const sourceBefore = await treeDigest(fixture.sourceRoot);
    const projectBefore = await treeDigest(fixture.projectRoot);
    let operations = await registerOperations(fixture);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");

    const preview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      { intent: captureIntent(fixture, skillId) },
    )) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
      steps: readonly {
        plan: { kind: string; actions: readonly { relativePath: string }[] };
        files: readonly { relativePath: string; change: string; byteLength?: number; afterHash?: string }[];
        bindingEffects: readonly unknown[];
        metadataEffects?: readonly unknown[];
        baseReferences?: readonly unknown[];
      }[];
    };
    if (preview.status !== "ready") throw new Error(JSON.stringify(preview));
    expect(preview.status).toBe("ready");
    expect(preview.steps[0]).toMatchObject({
      plan: { kind: "capture-skill" },
      bindingEffects: [],
      files: expect.arrayContaining([
        expect.objectContaining({ relativePath: "packages/tools/skills/captured-demo/SKILL.md", change: "add" }),
        expect.objectContaining({ relativePath: "packages/tools/skills/captured-demo/notes.md", change: "add" }),
        expect.objectContaining({
          relativePath: "packages/tools/skills/captured-demo/support/payload.bin",
          change: "add",
          byteLength: 4,
        }),
      ]),
    });
    expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);
    expect(await treeDigest(fixture.projectRoot)).toBe(projectBefore);

    const applied = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    )) as { status: string; receiptIds: readonly string[]; capture?: { variantId: string } };
    expect(applied.status).toBe("applied");
    expect(applied.receiptIds).toHaveLength(1);
    expect(applied.capture?.variantId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, "skills/captured-demo/support/payload.bin"))).toEqual(
      Buffer.from([0, 1, 255, 3]),
    );
    expect(await treeDigest(fixture.projectRoot)).toBe(projectBefore);

    const sourceRef = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: "skills/captured-demo" };
    expect(await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.variantOrigin)!({}, { source: sourceRef })).toMatchObject({
      status: "ready",
      source: sourceRef,
      origin: {
        variantId: applied.capture?.variantId,
        forkOf: skillId,
        capturedFrom: { location: { folderPath: projectSkill } },
      },
    });
    vi.resetModules();
    operations = await registerOperations(fixture);
    const recovery = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: { kind: "restore", operationId: preview.intentId },
      },
    )) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
      steps: readonly { plan: { kind: string }; files: readonly unknown[] }[];
    };
    if (recovery.status !== "ready") throw new Error(JSON.stringify(recovery));
    expect(recovery.status).toBe("ready");
    expect(recovery.steps[0]?.plan.kind).toBe("restore-apply");
    expect(recovery.steps[0]?.files).toHaveLength(5);
    const restored = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: recovery.intentId,
        effectFingerprint: recovery.effectFingerprint,
      },
    )) as { status: string; capture?: { status: string }; issues?: readonly unknown[] };
    if (restored.status !== "restored") throw new Error(JSON.stringify(restored));
    expect(restored.status).toBe("restored");
    expect(restored.capture?.status).toBe("restored");
    expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);
    expect(await treeDigest(fixture.projectRoot)).toBe(projectBefore);
  });

  it("keeps the original managed use, Binding, and base when capturing a managed copy", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    let operations = await registerOperations(fixture);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const adoption = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: {
          kind: "reconcile",
          request: {
            choice: "adopt-exact",
            skillId,
            source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
            locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
          },
        },
      },
    )) as { status: string; intentId: string; effectFingerprint: string };
    expect(adoption.status).toBe("ready");
    expect(
      await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
        {},
        {
          intentId: adoption.intentId,
          effectFingerprint: adoption.effectFingerprint,
        },
      ),
    ).toMatchObject({ status: "applied" });

    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
    const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
    const bindingStore = createBindingsStore(bindingsFilePath(fixture.userDataPath));
    const beforeRelationships = await relationships.read();
    const beforeBindings = await bindingStore.read();
    if (beforeRelationships.status !== "ready" || beforeBindings.status !== "ready")
      throw new Error("Managed fixture stores are unavailable.");
    const baseId = beforeRelationships.state.uses[0]!.baseRevisionId;
    const bases = createSkillBaseStore(fixture.userDataPath);
    const baseBefore = await bases.read(baseId);

    const capture = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      { intent: captureIntent(fixture, skillId) },
    )) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
    };
    if (capture.status !== "ready") throw new Error(JSON.stringify({ capture, beforeRelationships, beforeBindings }));
    expect(capture.status).toBe("ready");
    expect(
      await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
        {},
        {
          intentId: capture.intentId,
          effectFingerprint: capture.effectFingerprint,
        },
      ),
    ).toMatchObject({ status: "applied", targets: [] });
    const afterRelationships = await relationships.read();
    const afterBindings = await bindingStore.read();
    const baseAfter = await bases.read(baseId);
    expect(afterRelationships).toEqual(beforeRelationships);
    expect(afterBindings).toEqual(beforeBindings);
    expect(baseAfter).toEqual(baseBefore);

    expect(operations.skillManagement).toBeDefined();
  });

  it("withholds a stale copy and an occupied key before source writes", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    await registerOperations(fixture);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const sourceBefore = await treeDigest(fixture.sourceRoot);
    const collision = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      { intent: captureIntent(fixture, skillId, projectSkill, "demo") },
    )) as { status: string; reason?: string };
    expect(collision.status).toBe("needs-input");
    expect(collision.reason).toContain("already exists");
    expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);

    const preview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      { intent: captureIntent(fixture, skillId) },
    )) as { status: string; intentId: string; effectFingerprint: string };
    expect(preview.status).toBe("ready");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Edited after review.\n"),
    );
    const projectAfterEdit = await treeDigest(fixture.projectRoot);
    await expect(
      handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
        {},
        {
          intentId: preview.intentId,
          effectFingerprint: preview.effectFingerprint,
        },
      ),
    ).rejects.toThrow("The approved project copy");
    expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);
    expect(await treeDigest(fixture.projectRoot)).toBe(projectAfterEdit);
  });

  it("restores a fully published capture after an interruption following its receipt", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const { createOperationStore } = await import("../../src/main/operation-store");
    const underlying = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
    let interrupt = true;
    const operationStore: OperationStore = {
      read: () => underlying.read(),
      append: async (receipt) => {
        const result = await underlying.append(receipt);
        if (interrupt && receipt.kind === "capture-skill") {
          interrupt = false;
          throw new Error("Simulated interruption after capture receipt.");
        }
        return result;
      },
      markRestored: (operationId) => underlying.markRestored(operationId),
    };
    await registerOperations(fixture, operationStore);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const sourceBefore = await treeDigest(fixture.sourceRoot);
    const preview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      { intent: captureIntent(fixture, skillId) },
    )) as { status: string; intentId: string; effectFingerprint: string };
    expect(preview.status).toBe("ready");
    const interrupted = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    )) as { status: string; recoveryAvailable: boolean };
    expect(interrupted).toMatchObject({ status: "recovery-required", recoveryAvailable: true });

    vi.resetModules();
    await registerOperations(fixture, operationStore);
    const restore = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: { kind: "restore", operationId: preview.intentId },
      },
    )) as { status: string; intentId: string; effectFingerprint: string };
    expect(restore.status).toBe("ready");
    expect(
      await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
        {},
        {
          intentId: restore.intentId,
          effectFingerprint: restore.effectFingerprint,
        },
      ),
    ).toMatchObject({ status: "restored" });
    expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);
  });
});
