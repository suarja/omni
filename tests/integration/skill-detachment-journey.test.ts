import { rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { handlers } from "../ipc/apply-ipc-helpers";
import { managedFixture, previewIntent, applyPreview } from "./skill-resolution-fixture";
import { projectSkill, treeDigest, registerOperations } from "./skill-adoption-fixture";
import { SKILL_MANAGEMENT_IPC_CHANNELS } from "../../src/shared/skill-management-ipc";

it("stops one edited managed copy while preserving bytes, identity, peers, base, and receipt across restart", async () => {
  const fixture = await managedFixture();
  const operations = await registerOperations(fixture);
  await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Keep this local edit.\n");
  const beforeProject = await treeDigest(fixture.projectRoot);
  const beforeSource = await treeDigest(fixture.sourceRoot);
  const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
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

  const offlineSource = `${fixture.sourceRoot}-offline`;
  await rename(fixture.sourceRoot, offlineSource);
  try {
    const intent = {
      kind: "reconcile" as const,
      request: {
        choice: "detach-managed" as const,
        skillId: fixture.skillId,
        locations: [{ projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill }] as const,
      },
    };
    const preview = await previewIntent(intent);
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0]?.plan.kind).toBe("detach-skill");
    expect(preview.steps[0]?.plan.actions).toEqual([]);
    expect(preview.steps[0]?.files).toEqual([]);
    expect(preview.steps[0]?.bindingEffects).toEqual([
      { bindingId: selectedBinding.bindingId, before: selectedBinding },
    ]);

    const result = await applyPreview(preview);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "applied",
      detachment: { status: "detached", skillId: fixture.skillId },
    });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.status).toBe("applied");
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts?.[0]).toMatchObject({
      kind: "detach-skill",
      detachment: { intentId: preview.intentId, stepId: preview.steps[0]?.stepId },
    });
    expect(await treeDigest(fixture.projectRoot)).toBe(beforeProject);
    expect(await treeDigest(offlineSource)).toBe(beforeSource);

    const relationshipAfter = await relationships.read();
    const bindingAfter = await bindings.read();
    const baseAfter = await bases.read(selectedUse.baseRevisionId);
    expect(relationshipAfter.status).toBe("ready");
    expect(bindingAfter.status).toBe("ready");
    expect(baseAfter.status).toBe("ready");
    if (relationshipAfter.status === "ready" && bindingAfter.status === "ready" && baseAfter.status === "ready") {
      expect(relationshipAfter.state.skills).toEqual(relationshipBefore.state.skills);
      expect(relationshipAfter.state.uses).toEqual(
        relationshipBefore.state.uses.filter(
          (use) => !(use.skillId === selectedUse.skillId && use.bindingId === selectedUse.bindingId),
        ),
      );
      expect(bindingAfter.bindings).toEqual(
        bindingBefore.bindings.filter(({ bindingId }) => bindingId !== selectedBinding.bindingId),
      );
      expect(baseAfter).toMatchObject({ baseRevisionId: baseBefore.baseRevisionId, revision: baseBefore.revision });
      expect(relationshipAfter.state.skills.find(({ skillId }) => skillId === fixture.skillId)?.locations).toEqual(
        relationshipBefore.state.skills.find(({ skillId }) => skillId === fixture.skillId)?.locations,
      );
    }

    expect(await operations.skillManagement.readResult(preview.intentId)).toEqual(result);
    const restarted = await registerOperations(fixture);
    expect(await restarted.skillManagement.readResult(preview.intentId)).toEqual(result);
    const repeated = await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      { intentId: preview.intentId, effectFingerprint: preview.effectFingerprint },
    );
    expect(repeated).toEqual(result);
    expect((await stat(fixture.projectRoot)).isDirectory()).toBe(true);
  } finally {
    await rename(offlineSource, fixture.sourceRoot);
  }
});
