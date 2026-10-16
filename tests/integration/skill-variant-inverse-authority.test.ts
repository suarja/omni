import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSkillVariantRecoveryAdapter } from "../../src/main/skill-management/variant-recovery";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createOperationStore } from "../../src/main/operation-store";
import { managedFixture, previewIntent, applyPreview } from "./skill-resolution-fixture";
import { projectSkill, sourcePackage, treeDigest } from "./skill-adoption-fixture";

afterEach(() => vi.resetModules());

async function capturedFixture() {
  const fixture = await managedFixture();
  const preview = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "keep-variant",
      skillId: fixture.skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
      destination: { sourceId: fixture.source.id, packageId: sourcePackage, skillKey: "captured-demo" },
    },
  });
  const result = await applyPreview(preview);
  expect(result.status).toBe("applied");
  const journal = createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations"));
  const operationStore = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
  const read = await journal.read(result.intentId);
  const history = await operationStore.read();
  if (read.status !== "ready" || history.status !== "ready") throw new Error("Capture history unavailable.");
  const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  const adapter = createSkillVariantRecoveryAdapter({
    userDataPath: fixture.userDataPath,
    registry: fixture.registry,
    journal,
    operationStore,
    bindings,
    relationships: createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")),
    bases: createSkillBaseStore(fixture.userDataPath),
  });
  const receipt = history.receipts.find((item) => item.operationId === result.receiptIds[0])!;
  return { fixture, adapter, bindings, record: read.record, receipt };
}

it("withholds interrupted cleanup when a matching file has no durable ownership identity", async () => {
  const { fixture, adapter, record } = await capturedFixture();
  const before = await treeDigest(fixture.sourceRoot);
  const interrupted = {
    ...record,
    status: "recovery-required" as const,
    steps: record.steps.map((step) => ({
      ...step,
      status: "recovery-required" as const,
      actions: step.actions?.map((action) =>
        action.kind === "write-file" ? { ...action, identity: undefined, status: "failed" as const } : action,
      ),
    })),
  };
  const preview = await adapter.preview(interrupted, randomUUID());
  expect(preview).toMatchObject({ status: "blocked" });
  if (preview.status === "blocked") expect(preview.reason).toContain("durable write progress");
  expect(await treeDigest(fixture.sourceRoot)).toBe(before);
});

it("preserves the variant when a later Binding appears after restore progress begins", async () => {
  const { fixture, adapter, bindings, record, receipt } = await capturedFixture();
  const intentId = randomUUID();
  const preview = await adapter.preview(record, intentId, receipt);
  if (preview.status !== "ready") throw new Error(JSON.stringify(preview));
  await adapter.prepare(intentId, preview);
  const sourceBefore = await treeDigest(fixture.sourceRoot);
  const projectBefore = await treeDigest(fixture.projectRoot);
  let inserted = false;
  const outcome = await adapter.apply(intentId, preview, async (progress) => {
    if (
      !inserted &&
      progress.actions?.some((action) => action.kind === "delete-file" && action.status === "applying")
    ) {
      inserted = true;
      const state = await bindings.read();
      if (state.status !== "ready") throw new Error("Bindings unavailable.");
      const binding = state.bindings[0]!;
      expect(
        (
          await bindings.save([
            ...state.bindings,
            {
              ...binding,
              bindingId: randomUUID(),
              artifactPath: "skills/captured-demo/SKILL.md",
              boundHash: "a".repeat(64),
            },
          ])
        ).status,
      ).toBe("ready");
    }
  });
  expect(inserted).toBe(true);
  expect(outcome.status).toBe("recovery-required");
  expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);
  expect(await treeDigest(fixture.projectRoot)).toBe(projectBefore);
});
