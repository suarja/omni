import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileWriter } from "../../src/main/operation-files";
import type { RegistryIpcServices } from "../../src/main/registry-ipc";
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

afterEach(() => vi.resetModules());

async function adoptCopies(fixture: Awaited<ReturnType<typeof seedFixture>>, skillId: string): Promise<void> {
  const { SKILL_MANAGEMENT_IPC_CHANNELS: channels } = await import("../../src/shared/skill-management-ipc");
  const preview = (await handlers.get(channels.preview)!(
    {},
    {
      intent: {
        kind: "reconcile",
        request: {
          choice: "adopt-exact",
          skillId,
          source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
          locations: [
            { projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill },
            { projectId: fixture.project.id, harnessId: "claude-code", folderPath: claudeSkill },
          ],
        },
      },
    },
  )) as { status: string; intentId: string; effectFingerprint: string };
  expect(preview.status).toBe("ready");
  expect(
    await handlers.get(channels.apply)!(
      {},
      { intentId: preview.intentId, effectFingerprint: preview.effectFingerprint },
    ),
  ).toMatchObject({ status: "applied" });
}

async function observeManagedAttention(fixture: Awaited<ReturnType<typeof seedFixture>>) {
  const { SKILL_RECONCILIATION_IPC_CHANNELS } = await import("../../src/shared/skill-reconciliation-ipc");
  const inventory = await fixture.registry.observeEntryWithGrant(
    { kind: "project", id: fixture.project.id },
    fixture.project.grantHandle,
  );
  if (inventory.status !== "observed") throw new Error("Project inventory is unavailable.");
  const members = inventory.observation.inventory.artifacts
    .filter(
      (artifact) =>
        artifact.kind === "skill" &&
        [projectSkill, claudeSkill].some((folder) => artifact.relativePath === `${folder}/SKILL.md`),
    )
    .map((artifact) => ({
      ref: {
        kind: "artifact" as const,
        entry: { kind: "project" as const, id: fixture.project.id },
        artifactId: artifact.id,
      },
      relativePath: artifact.relativePath,
    }));
  return (await handlers.get(SKILL_RECONCILIATION_IPC_CHANNELS.observe)!(
    {},
    {
      projectId: fixture.project.id,
      grantHandle: fixture.project.grantHandle,
      groups: [{ groupId: "managed-copies", members }],
    },
  )) as {
    status: string;
    managedAttention?: readonly { skillId: string; location: { folderPath: string }; state: string }[];
  };
}

async function copySourceToCodex(fixture: Awaited<ReturnType<typeof seedFixture>>): Promise<void> {
  for (const relativePath of ["SKILL.md", "notes.md", "support/payload.bin"]) {
    const sourcePath = join(fixture.sourceRoot, sourcePackage, sourceSkill, relativePath);
    const targetPath = join(fixture.projectRoot, projectSkill, relativePath);
    await writeFile(targetPath, await readFile(sourcePath));
  }
}

async function resolve(
  skillId: string,
  projectId: string,
  choice: "keep-local" | "use-canonical",
): Promise<{
  status: string;
  intentId: string;
  effectFingerprint: string;
  steps: readonly {
    files: readonly { relativePath: string }[];
    bindingEffects?: readonly unknown[];
    metadataEffects?: readonly unknown[];
    plan?: { kind: string };
  }[];
}> {
  const { SKILL_MANAGEMENT_IPC_CHANNELS: channels } = await import("../../src/shared/skill-management-ipc");
  return (await handlers.get(channels.preview)!(
    {},
    {
      intent: {
        kind: "reconcile",
        request: { choice, skillId, locations: [{ projectId, harnessId: "codex", folderPath: projectSkill }] },
      },
    },
  )) as Awaited<ReturnType<typeof resolve>>;
}

describe("managed skill resolution through Desktop skill management", () => {
  it("keeps local content on request, uses the immutable canonical tree, and restores the selected copy", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    await registerOperations(fixture);
    await adoptCopies(fixture, skillId);

    const codexPayload = join(fixture.projectRoot, projectSkill, "support/payload.bin");
    const codexLocalOnly = join(fixture.projectRoot, projectSkill, "local-only.md");
    const sourceOnly = join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/source-only.md");
    const claudePayload = join(fixture.projectRoot, claudeSkill, "support/payload.bin");
    const canonicalPayload = join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/payload.bin");
    const originalLocalBytes = Buffer.from([9, 8, 7, 6]);
    await writeFile(codexPayload, originalLocalBytes);
    await writeFile(codexLocalOnly, "Keep this local-only file on restore.\n");
    await writeFile(sourceOnly, "This source-only file is canonical.\n");
    const claudeBefore = await readFile(claudePayload);
    const sourceBefore = await treeDigest(fixture.sourceRoot);
    const localBeforeResolution = await treeDigest(join(fixture.projectRoot, projectSkill));

    const keepLocal = await resolve(skillId, fixture.project.id, "keep-local");
    expect(keepLocal.status).toBe("ready");
    expect(keepLocal.steps[0]?.files).toEqual([]);
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const beforeKeepUses = await createSkillRelationshipStore(
      join(fixture.userDataPath, "omni/skill-relationships.json"),
    ).read();
    const beforeKeepBindings = await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read();
    const { SKILL_MANAGEMENT_IPC_CHANNELS: channels } = await import("../../src/shared/skill-management-ipc");
    expect(
      await handlers.get(channels.apply)!(
        {},
        { intentId: keepLocal.intentId, effectFingerprint: keepLocal.effectFingerprint },
      ),
    ).toMatchObject({ status: "applied", resolution: { targets: [{ status: "retained-local" }] } });
    expect(await readFile(codexPayload)).toEqual(originalLocalBytes);
    expect(
      await createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")).read(),
    ).toEqual(beforeKeepUses);
    expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toEqual(beforeKeepBindings);
    const attention = await observeManagedAttention(fixture);
    expect(attention.status).toBe("ready");
    expect(attention.managedAttention).toHaveLength(2);
    expect(attention.managedAttention).toEqual(
      expect.arrayContaining([
        { skillId, location: expect.objectContaining({ folderPath: projectSkill }), state: "local-change" },
        { skillId, location: expect.objectContaining({ folderPath: claudeSkill }), state: "matches-base" },
      ]),
    );

    const canonical = await resolve(skillId, fixture.project.id, "use-canonical");
    expect(canonical.status).toBe("ready");
    expect(canonical.steps[0]?.files.map(({ relativePath }) => relativePath)).toContain(
      `${projectSkill}/support/payload.bin`,
    );
    const applied = (await handlers.get(channels.apply)!(
      {},
      { intentId: canonical.intentId, effectFingerprint: canonical.effectFingerprint },
    )) as { status: string; receiptIds: readonly string[] };
    expect(applied.status, JSON.stringify(applied)).toBe("applied");
    expect(applied.receiptIds).toHaveLength(1);
    expect(await readFile(codexPayload)).toEqual(await readFile(canonicalPayload));
    expect(await readFile(join(fixture.projectRoot, projectSkill, "support/source-only.md"))).toEqual(
      await readFile(sourceOnly),
    );
    await expect(readFile(codexLocalOnly)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(claudePayload)).toEqual(claudeBefore);
    expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);

    const history = await (
      await import("../../src/main/operation-store")
    )
      .createOperationStore(join(fixture.userDataPath, "omni/operations.json"))
      .read();
    expect(history.status).toBe("ready");
    if (history.status !== "ready") throw new Error("Operation history is unavailable.");
    const child = history.receipts.find((receipt) => receipt.operationId === applied.receiptIds[0]);
    expect(child).toMatchObject({ kind: "resolve-skill", status: "applied" });

    const restored = (await handlers.get(channels.preview)!(
      {},
      { intent: { kind: "restore", operationId: applied.receiptIds[0] } },
    )) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
      steps: readonly { files: readonly unknown[] }[];
    };
    expect(restored.status).toBe("ready");
    expect(restored.steps[0]?.files.length).toBeGreaterThan(0);
    expect(
      await handlers.get(channels.apply)!(
        {},
        { intentId: restored.intentId, effectFingerprint: restored.effectFingerprint },
      ),
    ).toMatchObject({ status: "restored" });
    expect(await readFile(codexPayload)).toEqual(originalLocalBytes);
    expect(await treeDigest(join(fixture.projectRoot, projectSkill))).toBe(localBeforeResolution);
    expect(await readFile(claudePayload)).toEqual(claudeBefore);
    expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);
  }, 30000);

  it("refreshes only the selected base when local already equals source, then returns a receipt-free no-op", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    await registerOperations(fixture);
    await adoptCopies(fixture, skillId);

    const { SKILL_MANAGEMENT_IPC_CHANNELS: channels } = await import("../../src/shared/skill-management-ipc");
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
    const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
    const beforeUses = await relationships.read();
    const beforeBindings = await bindings.read();
    if (beforeUses.status !== "ready") throw new Error("Managed uses are unavailable.");
    const oldBaseId = beforeUses.state.uses.find((use) => use.location.folderPath === projectSkill)!.baseRevisionId;

    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "notes.md"), "Canonical v2 note.\n");
    await copySourceToCodex(fixture);
    const selectedTreeBefore = await treeDigest(join(fixture.projectRoot, projectSkill));
    const claudeTreeBefore = await treeDigest(join(fixture.projectRoot, claudeSkill));
    const refresh = await resolve(skillId, fixture.project.id, "use-canonical");
    expect(refresh.status).toBe("ready");
    expect(refresh.steps[0]?.files).toEqual([]);
    expect(refresh.steps[0]?.bindingEffects).toHaveLength(1);
    expect(refresh.steps[0]?.metadataEffects).toHaveLength(1);
    const refreshed = (await handlers.get(channels.apply)!(
      {},
      { intentId: refresh.intentId, effectFingerprint: refresh.effectFingerprint },
    )) as { status: string; receiptIds: readonly string[] };
    expect(refreshed.status).toBe("applied");
    expect(refreshed.receiptIds).toHaveLength(1);
    expect(await treeDigest(join(fixture.projectRoot, projectSkill))).toBe(selectedTreeBefore);
    expect(await treeDigest(join(fixture.projectRoot, claudeSkill))).toBe(claudeTreeBefore);

    const afterUses = await relationships.read();
    const afterBindings = await bindings.read();
    expect(afterUses.status).toBe("ready");
    expect(afterBindings.status).toBe("ready");
    if (afterUses.status !== "ready" || afterBindings.status !== "ready" || beforeBindings.status !== "ready")
      throw new Error("Managed metadata is unavailable.");
    const refreshedUse = afterUses.state.uses.find((use) => use.location.folderPath === projectSkill)!;
    const untouchedUse = afterUses.state.uses.find((use) => use.location.folderPath === claudeSkill)!;
    expect(refreshedUse.baseRevisionId).not.toBe(oldBaseId);
    expect(untouchedUse.baseRevisionId).toBe(oldBaseId);
    expect(afterBindings.bindings.map(({ bindingId }) => bindingId)).toEqual(
      beforeBindings.bindings.map(({ bindingId }) => bindingId),
    );

    const historyBeforeNoOp = await (
      await import("../../src/main/operation-store")
    )
      .createOperationStore(join(fixture.userDataPath, "omni/operations.json"))
      .read();
    const noOp = await resolve(skillId, fixture.project.id, "use-canonical");
    if (noOp.status !== "ready") throw new Error(JSON.stringify(noOp));
    const noOpStep = noOp.steps[0];
    if (!noOpStep) throw new Error("No-op resolution has no review step.");
    expect(noOpStep.plan?.kind).toBe("resolve-skill");
    expect(
      await handlers.get(channels.apply)!({}, { intentId: noOp.intentId, effectFingerprint: noOp.effectFingerprint }),
    ).toMatchObject({ status: "no-op", receiptIds: [] });
    const historyAfterNoOp = await (
      await import("../../src/main/operation-store")
    )
      .createOperationStore(join(fixture.userDataPath, "omni/operations.json"))
      .read();
    if (historyBeforeNoOp.status !== "ready" || historyAfterNoOp.status !== "ready")
      throw new Error("Operation history is unavailable.");
    expect(historyAfterNoOp.receipts.filter((receipt) => receipt.kind === "resolve-skill")).toHaveLength(
      historyBeforeNoOp.receipts.filter((receipt) => receipt.kind === "resolve-skill").length,
    );

    const postRefreshEdit = Buffer.from("A later local edit survives metadata-only restore.\n");
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), postRefreshEdit);
    const restore = (await handlers.get(channels.preview)!(
      {},
      { intent: { kind: "restore", operationId: refreshed.receiptIds[0] } },
    )) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
      steps: readonly { files: readonly unknown[] }[];
    };
    expect(restore.status).toBe("ready");
    expect(restore.steps[0]?.files).toEqual([]);
    expect(
      await handlers.get(channels.apply)!(
        {},
        { intentId: restore.intentId, effectFingerprint: restore.effectFingerprint },
      ),
    ).toMatchObject({ status: "restored" });
    expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"))).toEqual(postRefreshEdit);
    const restoredUses = await relationships.read();
    const restoredBindings = await bindings.read();
    if (restoredUses.status !== "ready" || restoredBindings.status !== "ready" || beforeBindings.status !== "ready")
      throw new Error("Restored metadata is unavailable.");
    expect(restoredUses.state.uses.find((use) => use.location.folderPath === projectSkill)?.baseRevisionId).toBe(
      oldBaseId,
    );
    expect(
      restoredBindings.bindings.find(
        (binding) => binding.projectId === fixture.project.id && binding.harnessId === "codex",
      ),
    ).toEqual(
      beforeBindings.bindings.find(
        (binding) => binding.projectId === fixture.project.id && binding.harnessId === "codex",
      ),
    );
  }, 30000);

  it("restores a partially replaced project from the saved backup while its source is unavailable", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    await registerOperations(fixture);
    await adoptCopies(fixture, skillId);

    const codexNotes = join(fixture.projectRoot, projectSkill, "notes.md");
    const codexPayload = join(fixture.projectRoot, projectSkill, "support/payload.bin");
    const canonicalNotes = join(fixture.sourceRoot, sourcePackage, sourceSkill, "notes.md");
    const originalNotes = Buffer.from("Local notes before canonical replacement.\n");
    const originalPayload = Buffer.from([9, 8, 7, 6]);
    await writeFile(codexNotes, originalNotes);
    await writeFile(codexPayload, originalPayload);

    let writes = 0;
    const failOnSecondWrite: FileWriter = async (path, content, options) => {
      writes += 1;
      if (writes === 2) throw new Error("Simulated interruption after one reviewed file write.");
      const { writeFile: write } = await import("node:fs/promises");
      await write(path, content, options);
    };
    vi.resetModules();
    await registerOperations(fixture, undefined, failOnSecondWrite);

    const canonical = await resolve(skillId, fixture.project.id, "use-canonical");
    expect(canonical.status).toBe("ready");
    expect(canonical.steps[0]?.files.length).toBe(2);
    const { SKILL_MANAGEMENT_IPC_CHANNELS: channels } = await import("../../src/shared/skill-management-ipc");
    const interrupted = (await handlers.get(channels.apply)!(
      {},
      { intentId: canonical.intentId, effectFingerprint: canonical.effectFingerprint },
    )) as { status: string; recoveryAvailable: boolean };
    expect(interrupted).toMatchObject({ status: "recovery-required", recoveryAvailable: true });
    expect(writes).toBe(2);
    expect(await readFile(codexNotes)).toEqual(await readFile(canonicalNotes));
    expect(await readFile(codexPayload)).toEqual(originalPayload);

    let sourceObservations = 0;
    const originalRegistry = fixture.registry;
    const offlineRegistry: RegistryIpcServices = {
      issue: originalRegistry.issue,
      get: originalRegistry.get,
      registerSourceByPath: originalRegistry.registerSourceByPath,
      hasActivePersonalSource: originalRegistry.hasActivePersonalSource,
      getGrantForEntry: originalRegistry.getGrantForEntry,
      getRegisteredRoot: originalRegistry.getRegisteredRoot,
      observeRegisteredEntry: originalRegistry.observeRegisteredEntry,
      observeEntryWithGrant: async (...values) => {
        if (values[0].kind === "source") sourceObservations += 1;
        return originalRegistry.observeEntryWithGrant(...values);
      },
      listRegistry: async () => {
        const view = await originalRegistry.listRegistry();
        if (view.status !== "ready") return view;
        return { ...view, registry: { ...view.registry, sources: [] } };
      },
    };
    vi.resetModules();
    await registerOperations(fixture, undefined, undefined, offlineRegistry);
    const foreignFile = join(fixture.projectRoot, projectSkill, "unexpected-local-file.md");
    await writeFile(foreignFile, "Do not overwrite unreviewed content.\n");
    const blockedRestore = (await handlers.get(channels.preview)!(
      {},
      { intent: { kind: "restore", operationId: canonical.intentId } },
    )) as { status: string };
    expect(blockedRestore.status).toBe("blocked");
    await rm(foreignFile);
    const restore = (await handlers.get(channels.preview)!(
      {},
      { intent: { kind: "restore", operationId: canonical.intentId } },
    )) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
      steps: readonly { files: readonly unknown[] }[];
    };
    expect(restore.status).toBe("ready");
    expect(restore.steps[0]?.files).toHaveLength(2);
    const recovered = (await handlers.get(channels.apply)!(
      {},
      { intentId: restore.intentId, effectFingerprint: restore.effectFingerprint },
    )) as { status: string; issues?: readonly unknown[] };
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ status: "restored" });
    expect(sourceObservations).toBe(0);
    expect(await readFile(codexNotes)).toEqual(originalNotes);
    expect(await readFile(codexPayload)).toEqual(originalPayload);
  }, 30000);
});
