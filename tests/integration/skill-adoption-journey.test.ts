import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationStore } from "../../src/main/operation-store";
import { handlers } from "../ipc/apply-ipc-helpers";
import {
  sourcePackage,
  sourceSkill,
  projectSkill,
  claudeSkill,
  treeDigest,
  seedFixture,
  observedSkillId,
  registerOperations,
} from "./skill-adoption-fixture";

function failAfterReceiptOnce(store: OperationStore, kinds: readonly string[]): OperationStore {
  const pending = new Set(kinds);
  return {
    read: () => store.read(),
    append: async (receipt) => {
      const result = await store.append(receipt);
      if (pending.delete(receipt.kind)) throw new Error(`Simulated interruption after ${receipt.kind} receipt.`);
      return result;
    },
    markRestored: (operationId) => store.markRestored(operationId),
  };
}

afterEach(() => vi.resetModules());

describe("exact skill adoption through Desktop skill management", () => {
  it("applies selected copies, reopens idempotently, and shares one immutable base", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const beforeSource = await treeDigest(fixture.sourceRoot);
    const beforeProject = await treeDigest(fixture.projectRoot);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const { createSkillBaseStore } = await import("../../src/main/skill-reconciliation/bases");
    const { createOperationStore } = await import("../../src/main/operation-store");
    await registerOperations(fixture);

    const request = (locations: readonly unknown[]) => ({
      kind: "reconcile",
      request: {
        choice: "adopt-exact",
        skillId,
        source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
        locations,
      },
    });
    const codexOnly = [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }];
    const preview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      { intent: request(codexOnly) },
    )) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
      steps: readonly {
        plan: { kind: string; actions: readonly unknown[] };
        files: readonly unknown[];
        bindingEffects: readonly unknown[];
        metadataEffects?: readonly unknown[];
        baseReferences?: readonly unknown[];
      }[];
    };
    expect(preview.status).toBe("ready");
    expect(preview.steps[0]).toMatchObject({
      plan: { kind: "adopt-skill", actions: [] },
      files: [],
      bindingEffects: [expect.any(Object)],
      metadataEffects: [expect.any(Object)],
      baseReferences: [expect.any(Object)],
    });
    const applied = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    )) as { status: string; receiptIds: readonly string[] };
    if (applied.status !== "applied") throw new Error(JSON.stringify(applied));
    expect(applied.receiptIds).toHaveLength(1);
    expect(await treeDigest(fixture.sourceRoot)).toBe(beforeSource);
    expect(await treeDigest(fixture.projectRoot)).toBe(beforeProject);

    const state = await createSkillRelationshipStore(
      join(fixture.userDataPath, "omni/skill-relationships.json"),
    ).read();
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("The relationship store is unavailable.");
    expect(state.state.uses).toHaveLength(1);
    expect(state.state.uses[0]).toMatchObject({
      skillId,
      location: { harnessId: "codex" },
      source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
    });
    expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toMatchObject({
      status: "ready",
      bindings: [expect.objectContaining({ bindingId: state.state.uses[0]!.bindingId, harnessId: "codex" })],
    });
    const inventory = await fixture.registry.observeEntryWithGrant(
      { kind: "project", id: fixture.project.id },
      fixture.project.grantHandle,
    );
    if (inventory.status !== "observed") throw new Error("Project inventory is unavailable.");
    const { SKILL_RECONCILIATION_IPC_CHANNELS } = await import("../../src/shared/skill-reconciliation-ipc");
    const split = (await handlers.get(SKILL_RECONCILIATION_IPC_CHANNELS.observe)!(
      {},
      {
        projectId: fixture.project.id,
        grantHandle: fixture.project.grantHandle,
        groups: [projectSkill, claudeSkill].map((path, index) => {
          const artifact = inventory.observation.inventory.artifacts.find(
            (item) => item.relativePath === path + "/SKILL.md",
          )!;
          return {
            groupId: index === 0 ? "managed-tools" : "individual-skills",
            members: [
              {
                ref: { kind: "artifact", entry: { kind: "project", id: fixture.project.id }, artifactId: artifact.id },
                relativePath: artifact.relativePath,
              },
            ],
          };
        }),
      },
    )) as { status: string; groups?: readonly { correlation: { groups: readonly { skillId: string }[] } }[] };
    expect(split.status).toBe("ready");
    expect(split.groups?.map((group) => group.correlation.groups[0]?.skillId)).toEqual([skillId, skillId]);
    const baseId = state.state.uses[0]!.baseRevisionId;
    expect((await createSkillBaseStore(fixture.userDataPath).read(baseId)).status).toBe("ready");
    const history = await createOperationStore(join(fixture.userDataPath, "omni/operations.json")).read();
    expect(history.status).toBe("ready");
    if (history.status === "ready") {
      expect(history.receipts.filter((receipt) => receipt.kind === "adopt-skill")).toHaveLength(1);
      const child = history.receipts.find((receipt) => receipt.kind === "adopt-skill")!;
      const { createSkillOperationJournal } = await import("../../src/main/skill-management/journal");
      const { resolveAdoptionReceiptRecord } = await import("../../src/main/skill-management/adoption-receipt");
      const journal = await createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations")).read(
        preview.intentId,
      );
      expect(resolveAdoptionReceiptRecord(child, journal)?.intentId).toBe(preview.intentId);
      for (const invalid of [
        { ...child, source: { kind: "source" as const, id: "another-source", relativePath: sourceSkill } },
        { ...child, project: { id: "another-project" } },
        { ...child, adoption: { intentId: "another-intent", stepId: child.operationId } },
        { ...child, adoption: { intentId: preview.intentId, stepId: "another-step" } },
      ])
        expect(resolveAdoptionReceiptRecord(invalid, journal)).toBeUndefined();
      expect(
        await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
          {},
          {
            intent: { kind: "restore", operationId: child.operationId },
          },
        ),
      ).toMatchObject({ status: "ready", steps: [expect.objectContaining({ files: [] })] });
    }

    vi.resetModules();
    await registerOperations(fixture);
    const replay = await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    );
    expect(replay).toMatchObject({ status: "applied", receiptIds: applied.receiptIds });
    const fresh = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!({}, { intent: request(codexOnly) })) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
    };
    const noOp = await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: fresh.intentId,
        effectFingerprint: fresh.effectFingerprint,
      },
    );
    expect(noOp).toMatchObject({ status: "no-op", receiptIds: [] });
    const afterNoOp = await createOperationStore(join(fixture.userDataPath, "omni/operations.json")).read();
    if (afterNoOp.status === "ready")
      expect(afterNoOp.receipts.filter((receipt) => receipt.kind === "adopt-skill")).toHaveLength(1);

    const unequalPath = join(fixture.projectRoot, claudeSkill, "support/payload.bin");
    const original = await readFile(unequalPath);
    await writeFile(unequalPath, Buffer.from([0, 1, 2, 3]));
    const both = [
      { projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill },
      { projectId: fixture.project.id, harnessId: "claude-code", folderPath: claudeSkill },
    ];
    const unequal = await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!({}, { intent: request(both) });
    expect(unequal).toMatchObject({ status: "needs-input" });
    await writeFile(unequalPath, original);

    const bothPreview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!({}, { intent: request(both) })) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
    };
    expect(bothPreview.status).toBe("ready");
    const bothApplied = await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: bothPreview.intentId,
        effectFingerprint: bothPreview.effectFingerprint,
      },
    );
    expect(bothApplied).toMatchObject({ status: "applied" });
    const finalState = await createSkillRelationshipStore(
      join(fixture.userDataPath, "omni/skill-relationships.json"),
    ).read();
    expect(finalState.status).toBe("ready");
    if (finalState.status === "ready") {
      expect(finalState.state.uses).toHaveLength(2);
      expect(new Set(finalState.state.uses.map((use) => use.baseRevisionId))).toEqual(new Set([baseId]));
    }
    expect(await treeDigest(fixture.sourceRoot)).toBe(beforeSource);
    expect(await treeDigest(fixture.projectRoot)).toBe(beforeProject);
  });

  it("recovers a saved adoption after interruption and retries an interrupted restore without duplicate receipts", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const { createOperationStore } = await import("../../src/main/operation-store");
    const realStore = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
    const interruptedStore = failAfterReceiptOnce(realStore, ["adopt-skill", "restore-apply"]);
    await registerOperations(fixture, interruptedStore);
    const intent = {
      kind: "reconcile",
      request: {
        choice: "adopt-exact",
        skillId,
        source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
        locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
      },
    };
    const adoption = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!({}, { intent })) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
    };
    expect(adoption.status).toBe("ready");
    const interruptedApply = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      { intentId: adoption.intentId, effectFingerprint: adoption.effectFingerprint },
    )) as { status: string };
    expect(interruptedApply.status).toBe("recovery-required");

    vi.resetModules();
    await registerOperations(fixture, interruptedStore);
    const restore = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      { intent: { kind: "restore", operationId: adoption.intentId } },
    )) as { status: string; intentId: string; effectFingerprint: string };
    expect(restore.status).toBe("ready");
    const interruptedRestore = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      { intentId: restore.intentId, effectFingerprint: restore.effectFingerprint },
    )) as { status: string };
    expect(interruptedRestore.status).toBe("recovery-required");

    vi.resetModules();
    const operations = await registerOperations(fixture);
    const retry = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      { intent: { kind: "restore", operationId: adoption.intentId } },
    )) as { status: string; intentId: string; effectFingerprint: string };
    expect(retry.status).toBe("ready");
    const recovered = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      { intentId: retry.intentId, effectFingerprint: retry.effectFingerprint },
    )) as { status: string; issues?: readonly unknown[] };
    expect(recovered.status, JSON.stringify(recovered)).toBe("restored");
    expect(await operations.skillManagement.readResult(adoption.intentId)).toMatchObject({ status: "restored" });
    const history = await realStore.read();
    expect(history.status).toBe("ready");
    if (history.status === "ready") {
      expect(history.receipts.filter((receipt) => receipt.kind === "adopt-skill")).toHaveLength(1);
      expect(history.receipts.filter((receipt) => receipt.kind === "restore-apply")).toHaveLength(1);
    }
  });

  it.each(["binding", "managed use"] as const)(
    "recovers an interruption after the %s write while preserving newer unrelated contents",
    async (interruption) => {
      const fixture = await seedFixture();
      const skillId = await observedSkillId(fixture);
      const { SKILL_MANAGEMENT_IPC_CHANNELS: channels } = await import("../../src/shared/skill-management-ipc");
      const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
      const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
      const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
      const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
      const beforeBindings = await bindings.read();
      const beforeUses = await relationships.read();
      await registerOperations(fixture);
      if (interruption === "binding") {
        const write = bindings.updateExact.bind(bindings);
        vi.spyOn(bindings, "updateExact").mockImplementationOnce(async (effects) => {
          await write(effects);
          throw new Error("Simulated interruption after the binding write.");
        });
      } else {
        const write = relationships.updateUsesExact.bind(relationships);
        vi.spyOn(relationships, "updateUsesExact").mockImplementationOnce(async (revision, effects) => {
          await write(revision, effects);
          throw new Error("Simulated interruption after the managed-use write.");
        });
      }
      const preview = (await handlers.get(channels.preview)!(
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
      expect(preview.status).toBe("ready");
      expect(
        await handlers.get(channels.apply)!(
          {},
          {
            intentId: preview.intentId,
            effectFingerprint: preview.effectFingerprint,
          },
        ),
      ).toMatchObject({ status: "recovery-required", recoveryAvailable: true });
      expect(await relationships.read()).toMatchObject({
        status: "ready",
        state: { uses: interruption === "binding" ? [] : [expect.any(Object)] },
      });
      // Recovery removes metadata only; later source and unselected-copy edits must survive.
      await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "notes.md"), "New canonical note.\n");
      await writeFile(join(fixture.projectRoot, claudeSkill, "notes.md"), "Local Claude edit.\n");
      const sourceBeforeRecovery = await treeDigest(fixture.sourceRoot);
      const projectBeforeRecovery = await treeDigest(fixture.projectRoot);
      vi.restoreAllMocks();
      vi.resetModules();
      const reopened = await registerOperations(fixture);
      const restore = (await handlers.get(channels.preview)!(
        {},
        {
          intent: { kind: "restore", operationId: preview.intentId },
        },
      )) as {
        status: string;
        intentId: string;
        effectFingerprint: string;
        steps: readonly {
          files: readonly unknown[];
          bindingEffects: readonly unknown[];
          metadataEffects?: readonly unknown[];
        }[];
      };
      expect(restore.status).toBe("ready");
      expect(restore.steps[0]?.files).toEqual([]);
      expect(restore.steps[0]?.bindingEffects).toHaveLength(1);
      expect(restore.steps[0]?.metadataEffects ?? []).toHaveLength(interruption === "binding" ? 0 : 1);
      expect(
        await handlers.get(channels.apply)!(
          {},
          {
            intentId: restore.intentId,
            effectFingerprint: restore.effectFingerprint,
          },
        ),
      ).toMatchObject({ status: "restored" });
      const { createBindingsStore: reopenedBindings, bindingsFilePath: reopenedPath } =
        await import("../../src/main/bindings-store");
      const { createSkillRelationshipStore: reopenedRelationships } =
        await import("../../src/main/skill-reconciliation/store");
      expect(await reopenedBindings(reopenedPath(fixture.userDataPath)).read()).toEqual(beforeBindings);
      const afterUses = await reopenedRelationships(join(fixture.userDataPath, "omni/skill-relationships.json")).read();
      if (beforeUses.status !== "ready" || afterUses.status !== "ready")
        throw new Error("Relationship evidence is unavailable.");
      expect(afterUses.state.uses).toEqual(beforeUses.state.uses);
      expect(afterUses.state.skills).toEqual(beforeUses.state.skills);
      expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBeforeRecovery);
      expect(await treeDigest(fixture.projectRoot)).toBe(projectBeforeRecovery);
      expect(await reopened.skillManagement.readResult(preview.intentId)).toMatchObject({ status: "restored" });
    },
  );

  it("rejects a stale support-file preview without writing adoption metadata", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const { SKILL_MANAGEMENT_IPC_CHANNELS: channels } = await import("../../src/shared/skill-management-ipc");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
    const beforeBindings = await bindings.read();
    await registerOperations(fixture);
    const preview = (await handlers.get(channels.preview)!(
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
    expect(preview.status).toBe("ready");
    await writeFile(join(fixture.projectRoot, projectSkill, "support/payload.bin"), Buffer.from([4, 5, 6]));
    const beforeApply = await treeDigest(fixture.projectRoot);
    const result = (await handlers.get(channels.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    )) as { status: string };
    expect(result.status).toBe("failed");
    expect(await bindings.read()).toEqual(beforeBindings);
    expect(
      await createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")).read(),
    ).toMatchObject({ status: "ready", state: { uses: [] } });
    expect(await treeDigest(fixture.projectRoot)).toBe(beforeApply);
  });
});
