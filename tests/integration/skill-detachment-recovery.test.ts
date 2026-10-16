import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";
import type { Binding } from "../../src/domain/assignment-plan";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { readSkillDetachmentSnapshot } from "../../src/main/skill-management/detachment-reader";
import { planSkillDetachmentRecovery } from "../../src/main/skill-management/detachment-recovery-plan";
import { managedFixture, previewIntent, applyPreview } from "./skill-resolution-fixture";
import { projectSkill, treeDigest, registerOperations as registerBaseOperations } from "./skill-adoption-fixture";

async function registerWithProgressFailure(
  fixture: Awaited<ReturnType<typeof managedFixture>>,
  failAt: number,
): Promise<void> {
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  let progressCount = 0;
  const operations = registerOperationsIpcHandlers(() => undefined, fixture.registry, {
    userDataPath: fixture.userDataPath,
    applyRestore: fixture.applyRestore,
    bindings: fixture.bindings,
    now: Date.now,
    onSkillProgress: () => {
      progressCount += 1;
      if (progressCount === failAt) throw new Error("Injected interruption after journal acknowledgment.");
    },
  });
  await operations.skillManagement.initialize();
}

it("restores one stopped copy from its public parent while the source is offline", async () => {
  const fixture = await managedFixture();
  const beforeProject = await treeDigest(fixture.projectRoot);
  const beforeSource = await treeDigest(fixture.sourceRoot);
  const relationships = createSkillRelationshipStore(`${fixture.userDataPath}/omni/skill-relationships.json`);
  const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  const bases = createSkillBaseStore(fixture.userDataPath);
  const relationshipBefore = await relationships.read();
  const bindingBefore = await bindings.read();
  if (relationshipBefore.status !== "ready" || bindingBefore.status !== "ready")
    throw new Error("Fixture stores are unavailable.");
  const selectedUse = relationshipBefore.state.uses.find(
    ({ skillId, location }) => skillId === fixture.skillId && location.harnessId === "codex",
  );
  if (!selectedUse) throw new Error("The selected managed copy is missing.");
  const selectedBinding = bindingBefore.bindings.find(({ bindingId }) => bindingId === selectedUse.bindingId);
  if (!selectedBinding) throw new Error("The selected Binding is missing.");
  const baseBefore = await bases.read(selectedUse.baseRevisionId);
  if (baseBefore.status !== "ready") throw new Error("The immutable base is unavailable.");

  const detached = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "detach-managed",
      skillId: fixture.skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect(detached.status).toBe("ready");
  if (detached.status !== "ready") return;
  expect((await applyPreview(detached)).status).toBe("applied");

  const offlineSource = `${fixture.sourceRoot}-offline`;
  await rename(fixture.sourceRoot, offlineSource);
  try {
    const preview = await previewIntent({ kind: "restore", operationId: detached.intentId });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0]?.plan.kind).toBe("detach-skill");
    expect(preview.steps[0]?.plan.actions).toEqual([]);
    expect(preview.steps[0]?.files).toEqual([]);
    expect(preview.steps[0]?.detachmentRestoreOrigin).toMatchObject({ intentId: detached.intentId });
    expect(preview.steps[0]?.bindingEffects).toEqual([
      { bindingId: selectedBinding.bindingId, after: selectedBinding },
    ]);
    expect(preview.steps[0]?.metadataEffects).toEqual([
      { skillId: fixture.skillId, location: selectedUse.location, after: selectedUse },
    ]);

    const restored = await applyPreview(preview);
    expect(restored.status).toBe("restored");
    expect(restored.detachment).toMatchObject({ status: "restored", skillId: fixture.skillId });
    expect(await applyPreview(preview)).toEqual(restored);
    expect(await treeDigest(fixture.projectRoot)).toBe(beforeProject);
    expect(await treeDigest(offlineSource)).toBe(beforeSource);
    const relationshipFile = JSON.parse(
      await readFile(join(fixture.userDataPath, "omni/skill-relationships.json"), "utf8"),
    ) as {
      skills: unknown;
      uses: unknown;
    };
    const bindingsFile = JSON.parse(await readFile(bindingsFilePath(fixture.userDataPath), "utf8")) as {
      bindings: readonly Binding[];
    };
    expect(relationshipFile.skills).toEqual(relationshipBefore.state.skills);
    expect(relationshipFile.uses).toEqual(relationshipBefore.state.uses);
    expect(bindingsFile.bindings).toEqual(bindingBefore.bindings);
    expect(await bases.read(selectedUse.baseRevisionId)).toMatchObject({
      status: "ready",
      baseRevisionId: baseBefore.baseRevisionId,
      revision: baseBefore.revision,
    });
  } finally {
    await rename(offlineSource, fixture.sourceRoot);
  }
});

it("restores only the acknowledged Binding after an interruption and withholds an acknowledgment gap", async () => {
  const fixture = await managedFixture();
  const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
  const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  const before = await relationships.read();
  if (before.status !== "ready") throw new Error("Fixture relationships are unavailable.");
  const selectedUse = before.state.uses.find(
    ({ skillId, location }) => skillId === fixture.skillId && location.harnessId === "codex",
  );
  if (!selectedUse) throw new Error("The selected managed use is missing.");
  const beforeBindings = await bindings.read();
  if (beforeBindings.status !== "ready") throw new Error("Fixture Bindings are unavailable.");
  const originalBinding = beforeBindings.bindings.find(({ bindingId }) => bindingId === selectedUse.bindingId);
  if (!originalBinding) throw new Error("The selected Binding is missing.");

  await registerWithProgressFailure(fixture, 2);
  const detached = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "detach-managed",
      skillId: fixture.skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect(detached.status).toBe("ready");
  if (detached.status !== "ready") return;
  const interruptedResult = await applyPreview(detached);
  expect(interruptedResult.status).toBe("recovery-required");

  const journal = createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations"));
  const interrupted = await journal.read(detached.intentId);
  if (interrupted.status !== "ready") throw new Error("The interrupted journal is unavailable.");
  const originalStep = interrupted.record.effect?.steps[0];
  if (!originalStep?.detachmentEvidence) throw new Error("The saved detachment evidence is missing.");
  const request = {
    choice: "detach-managed" as const,
    skillId: fixture.skillId,
    locations: [originalStep.detachmentEvidence.local.location] as const,
  };
  const snapshot = await readSkillDetachmentSnapshot(request, {
    registry: fixture.registry,
    relationships,
    bindings,
    bases: (await import("../../src/main/skill-reconciliation/bases")).createSkillBaseStore(fixture.userDataPath),
  });
  expect(snapshot.status).toBe("ready");
  if (snapshot.status !== "ready") return;
  const bindingsFileAfterFailure = JSON.parse(await readFile(bindingsFilePath(fixture.userDataPath), "utf8")) as {
    bindings: readonly Binding[];
  };
  expect(bindingsFileAfterFailure.bindings.some(({ bindingId }) => bindingId === originalBinding.bindingId)).toBe(
    false,
  );
  expect(interrupted.record.steps[0]?.managementProgress).toEqual({ bindings: "applied", uses: "pending" });
  const persistedSnapshot = { ...snapshot, bindings: bindingsFileAfterFailure.bindings };
  expect(persistedSnapshot.relationships.uses).toContainEqual(selectedUse);
  const gap = planSkillDetachmentRecovery({
    snapshot: persistedSnapshot,
    evidence: originalStep.detachmentEvidence,
    baseMatches: true,
    progress: { bindings: "pending", uses: "pending" },
  });
  expect(gap.status).toBe("blocked");
  const acknowledged = planSkillDetachmentRecovery({
    snapshot: persistedSnapshot,
    evidence: originalStep.detachmentEvidence,
    baseMatches: true,
    progress: interrupted.record.steps[0]?.managementProgress,
  });
  expect(acknowledged, JSON.stringify(acknowledged)).toMatchObject({
    status: "restore",
    restoreBinding: true,
    restoreUse: false,
  });
  expect(await relationships.read()).toMatchObject({
    status: "ready",
    state: { uses: expect.arrayContaining([selectedUse]) },
  });

  await registerBaseOperations(fixture);
  const restore = await previewIntent({ kind: "restore", operationId: detached.intentId });
  expect(restore.status).toBe("ready");
  if (restore.status !== "ready") return;
  expect(restore.steps[0]?.bindingEffects).toEqual([{ bindingId: originalBinding.bindingId, after: originalBinding }]);
  expect(restore.steps[0]?.metadataEffects).toEqual([
    { skillId: fixture.skillId, location: selectedUse.location, before: selectedUse, after: selectedUse },
  ]);
  const restored = await applyPreview(restore);
  expect(restored.status).toBe("restored");
  const bindingsFileAfterRestore = JSON.parse(await readFile(bindingsFilePath(fixture.userDataPath), "utf8")) as {
    bindings: readonly Binding[];
  };
  expect(bindingsFileAfterRestore.bindings).toContainEqual(originalBinding);
  expect(await relationships.read()).toMatchObject({
    status: "ready",
    state: { uses: expect.arrayContaining([selectedUse]) },
  });
});

it("closes an acknowledged before-state interruption as a receipt-free no-op", async () => {
  const fixture = await managedFixture();
  await registerWithProgressFailure(fixture, 1);
  const detached = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "detach-managed",
      skillId: fixture.skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect(detached.status).toBe("ready");
  if (detached.status !== "ready") return;
  expect((await applyPreview(detached)).status).toBe("recovery-required");

  await registerBaseOperations(fixture);
  const recovery = await previewIntent({ kind: "restore", operationId: detached.intentId });
  expect(recovery.status).toBe("ready");
  if (recovery.status !== "ready") return;
  expect(recovery.steps[0]?.bindingEffects[0]).toMatchObject({ before: expect.any(Object), after: expect.any(Object) });
  expect(recovery.steps[0]?.metadataEffects?.[0]).toMatchObject({
    before: expect.any(Object),
    after: expect.any(Object),
  });
  const result = await applyPreview(recovery);
  expect(result).toMatchObject({
    status: "no-op",
    receiptIds: [],
    detachment: { status: "unchanged", skillId: fixture.skillId },
  });
});
