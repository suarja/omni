import { join } from "node:path";
import { expect, it } from "vitest";

import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { managedFixture, previewIntent, applyPreview } from "./skill-resolution-fixture";
import { projectSkill, treeDigest, registerOperations } from "./skill-adoption-fixture";

async function registerInverseInterruption(
  fixture: Awaited<ReturnType<typeof managedFixture>>,
  failAt: number,
): Promise<void> {
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  let progressCount = 0;
  const operations = registerOperationsIpcHandlers(() => undefined, fixture.registry, {
    userDataPath: fixture.userDataPath,
    applyRestore: fixture.applyRestore,
    bindings: fixture.bindings,
    onSkillProgress: () => {
      progressCount += 1;
      if (progressCount === failAt) throw new Error("Interrupted inverse after durable metadata acknowledgment.");
    },
  });
  await operations.skillManagement.initialize();
}

async function interruptInverse(failAt: number) {
  const fixture = await managedFixture();
  const before = await treeDigest(fixture.projectRoot);
  const detach = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "detach-managed",
      skillId: fixture.skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect((await applyPreview(detach)).status).toBe("applied");
  await registerInverseInterruption(fixture, failAt);
  const inverse = await previewIntent({ kind: "restore", operationId: detach.intentId });
  expect(inverse.status).toBe("ready");
  expect((await applyPreview(inverse)).status).toBe("recovery-required");
  const journal = createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations"));
  const interrupted = await journal.read(inverse.intentId);
  if (interrupted.status !== "ready") throw new Error("Expected durable interrupted inverse journal.");
  expect(interrupted.record.steps[0]?.managementProgress?.bindings).toBe("applied");
  await registerOperations(fixture);
  return { fixture, before, detach, inverse, journal, interrupted: interrupted.record };
}

it.each([2, 3])(
  "completes public-parent restoration after inverse interruption at acknowledgment %i",
  async (failAt) => {
    const { fixture, before, detach, journal, inverse } = await interruptInverse(failAt);
    const recovery = await previewIntent({ kind: "restore", operationId: detach.intentId });
    expect(recovery.status, JSON.stringify(recovery)).toBe("ready");
    const result = await applyPreview(recovery);
    expect(result.status).toBe("restored");
    expect(result.detachment?.status).toBe("restored");
    expect(await applyPreview(recovery)).toEqual(result);
    expect(await treeDigest(fixture.projectRoot)).toBe(before);
    expect(await journal.read(inverse.intentId)).toMatchObject({ status: "ready", record: { status: "terminal" } });
    const next = await previewIntent({
      kind: "reconcile",
      request: {
        choice: "detach-managed",
        skillId: fixture.skillId,
        locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
      },
    });
    expect((await applyPreview(next)).status).toBe("applied");
  },
);

it("recovers from the interrupted inverse's public operation without using generic file recovery", async () => {
  const { inverse } = await interruptInverse(2);
  const recovery = await previewIntent({ kind: "restore", operationId: inverse.intentId });
  expect(recovery.status, JSON.stringify(recovery)).toBe("ready");
  if (recovery.status !== "ready") return;
  expect(recovery.steps[0]?.detachmentRestoreOrigin).toBeDefined();
  expect(recovery.steps[0]?.files).toEqual([]);
  expect((await applyPreview(recovery)).status).toBe("restored");
});

it("withholds inverse recovery when a restored Binding has no durable write acknowledgment", async () => {
  const { detach, journal, interrupted } = await interruptInverse(2);
  await journal.write({
    ...interrupted,
    steps: interrupted.steps.map((step) => ({ ...step, managementProgress: { bindings: "pending", uses: "pending" } })),
  });
  const recovery = await previewIntent({ kind: "restore", operationId: detach.intentId });
  expect(recovery.status).toBe("blocked");
});

it("closes every acknowledged inverse attempt after repeated interruptions", async () => {
  const { fixture, detach, inverse, journal } = await interruptInverse(2);
  await registerInverseInterruption(fixture, 2);
  const second = await previewIntent({ kind: "restore", operationId: detach.intentId });
  expect(second.status).toBe("ready");
  expect((await applyPreview(second)).status).toBe("recovery-required");
  await registerOperations(fixture);
  const final = await previewIntent({ kind: "restore", operationId: detach.intentId });
  expect((await applyPreview(final)).status).toBe("restored");
  for (const intentId of [inverse.intentId, second.intentId])
    expect(await journal.read(intentId)).toMatchObject({ status: "ready", record: { status: "terminal" } });
  const next = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "detach-managed",
      skillId: fixture.skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect((await applyPreview(next)).status).toBe("applied");
});

it.each(["before", "after"])(
  "reuses the durable inverse receipt when interruption occurs %s history marking",
  async (phase) => {
    const fixture = await managedFixture();
    const detach = await previewIntent({
      kind: "reconcile",
      request: {
        choice: "detach-managed",
        skillId: fixture.skillId,
        locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
      },
    });
    expect((await applyPreview(detach)).status).toBe("applied");
    const { createOperationStore } = await import("../../src/main/operation-store");
    const store = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
    await registerOperations(fixture, {
      ...store,
      markRestored: async (operationId) => {
        if (phase === "after") await store.markRestored(operationId);
        throw new Error("Interrupted after inverse receipt.");
      },
    });
    const inverse = await previewIntent({ kind: "restore", operationId: detach.intentId });
    expect((await applyPreview(inverse)).status).toBe("recovery-required");
    const before = await store.read();
    if (before.status !== "ready") throw new Error("Expected durable inverse receipt.");
    const child = before.receipts.find(
      (receipt) => receipt.kind === "detach-skill" && receipt.detachment?.intentId === inverse.intentId,
    );
    expect(child).toBeDefined();
    await registerOperations(fixture);
    const retry = await previewIntent({ kind: "restore", operationId: detach.intentId });
    const result = await applyPreview(retry);
    expect(result.status).toBe("restored");
    expect(result.receiptIds).toEqual([child!.operationId]);
    const after = await createOperationStore(join(fixture.userDataPath, "omni/operations.json")).read();
    if (after.status !== "ready") throw new Error("Expected completed inverse history.");
    expect(
      after.receipts.filter(
        (receipt) => receipt.restores === (detach.status === "ready" ? detach.steps[0]?.stepId : undefined),
      ),
    ).toHaveLength(1);
  },
);

it("withholds recovery when interrupted inverse attempts have ambiguous ordering", async () => {
  const { fixture, detach, inverse, journal, interrupted } = await interruptInverse(2);
  await registerInverseInterruption(fixture, 2);
  const second = await previewIntent({ kind: "restore", operationId: detach.intentId });
  expect((await applyPreview(second)).status).toBe("recovery-required");
  const saved = await journal.read(second.intentId);
  if (saved.status !== "ready") throw new Error("Expected second interrupted inverse.");
  await journal.write({ ...saved.record, createdAt: interrupted.createdAt });
  await registerOperations(fixture);
  const retry = await previewIntent({ kind: "restore", operationId: inverse.intentId });
  expect(retry.status).toBe("blocked");
});
