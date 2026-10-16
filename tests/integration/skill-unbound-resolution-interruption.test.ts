import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  seedFixture,
  observedSkillId,
  registerOperations,
  projectSkill,
  sourcePackage,
  sourceSkill,
  treeDigest,
} from "./skill-adoption-fixture";
import { previewIntent, applyPreview } from "./skill-resolution-fixture";
import { createSkillUnboundResolutionAdapter } from "../../src/main/skill-management/unbound-resolution";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createOperationStore } from "../../src/main/operation-store";

it("recovers a durable file replacement interrupted before management publication", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  await registerOperations(fixture);
  await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Local before interruption.\r\n");
  const before = await treeDigest(fixture.projectRoot);
  const intent = {
    kind: "reconcile",
    request: {
      choice: "link-canonical",
      skillId,
      source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  } as const;
  const preview = await previewIntent(intent);
  if (preview.status !== "ready") throw new Error("Expected a link preview.");
  const journal = createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations"));
  const saved = await journal.read(preview.intentId);
  if (saved.status !== "ready") throw new Error("Expected a saved parent.");
  const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
  const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  const adapter = createSkillUnboundResolutionAdapter({
    userDataPath: fixture.userDataPath,
    registry: fixture.registry,
    relationships,
    bindings,
    bases: createSkillBaseStore(fixture.userDataPath),
    operationStore: createOperationStore(join(fixture.userDataPath, "omni/operations.json")),
    journal,
  });
  const effect = await adapter.preview(intent, preview.intentId, Date.parse(saved.record.createdAt));
  if (effect.status !== "ready") throw new Error("Expected a rehydrated reviewed effect.");
  await adapter.prepare(preview.intentId, effect);
  let interrupted = false;
  const outcome = await adapter.apply(preview.intentId, effect, async (progress) => {
    await journal.write({
      ...saved.record,
      status: "recovery-required",
      updatedAt: new Date().toISOString(),
      steps: [{ ...progress }],
    });
    if (!interrupted && progress.actions?.some((action) => action.status === "applied")) {
      interrupted = true;
      throw new Error("Simulated interruption after durable file progress.");
    }
  });
  expect(outcome.status).toBe("recovery-required");
  expect(await relationships.read()).toMatchObject({ state: { uses: [] } });
  expect(await bindings.read()).toMatchObject({ bindings: [] });
  await registerOperations(fixture);
  const restore = await previewIntent({ kind: "restore", operationId: preview.intentId });
  expect(restore.status, JSON.stringify(restore)).toBe("ready");
  if (restore.status !== "ready") throw new Error("Expected interrupted-file recovery.");
  expect(restore.steps[0]?.metadataEffects).toEqual([]);
  expect(restore.steps[0]?.bindingEffects).toEqual([]);
  expect((await applyPreview(restore)).status).toBe("restored");
  expect(await treeDigest(fixture.projectRoot)).toBe(before);
});
