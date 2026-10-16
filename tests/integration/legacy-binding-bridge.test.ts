import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createOperationStore } from "../../src/main/operation-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { hashGrantedPath } from "../../src/main/granted-hashing";
import { APPLY_IPC_CHANNELS } from "../../src/shared/apply-ipc";
import { BINDINGS_IPC_CHANNELS } from "../../src/shared/bindings-ipc";
import { handlers, root } from "../ipc/apply-ipc-helpers";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import {
  claudeSkill,
  projectSkill,
  sourcePackage,
  sourceSkill,
  seedFixture,
  registerOperations,
  treeDigest,
} from "./skill-adoption-fixture";

async function legacyFixture() {
  const fixture = await seedFixture();
  const secondRoot = await root("legacy-second");
  const secondProject = await fixture.registerProjectRoot(secondRoot);
  for (const folder of [projectSkill, claudeSkill])
    await cp(join(fixture.projectRoot, folder), join(secondRoot, folder), { recursive: true });
  const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
  const hashed = await hashGrantedPath(fixture.projectGrant, projectSkill);
  if (hashed.status !== "hashed") throw new Error("Legacy copy hash is unavailable.");
  const projects = [
    { ...fixture.project, root: fixture.projectRoot },
    { ...secondProject, root: secondRoot },
  ];
  const bindings = projects.flatMap((project, index) =>
    ["codex", "claude-code"].map((harnessId) => ({
      bindingId: `legacy-${index}-${harnessId}`,
      ...source,
      kind: "skill" as const,
      projectId: project.id,
      harnessId: harnessId as "codex" | "claude-code",
      boundHash: hashed.contentHash,
      ownedHash: hashed.contentHash,
      createdAt: "2026-10-11T00:00:00.000Z",
    })),
  );
  const bindingStore = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  await bindingStore.save(bindings);
  const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni", "skill-relationships.json"));
  const history = createOperationStore(join(fixture.userDataPath, "omni", "operations.json"));
  return { ...fixture, projects, sourceRef: source, legacyBindings: bindings, bindingStore, relationships, history };
}

async function readyRelationships(fixture: Awaited<ReturnType<typeof legacyFixture>>) {
  const loaded = await fixture.relationships.read();
  if (loaded.status !== "ready") throw new Error("Relationships are unavailable.");
  return loaded.state;
}

async function bridgeReceipts(fixture: Awaited<ReturnType<typeof legacyFixture>>) {
  const loaded = await fixture.history.read();
  if (loaded.status !== "ready") throw new Error("History is unavailable.");
  return loaded.receipts.filter(({ kind }) => kind === "bridge-skill-uses");
}

describe("legacy Binding bridge", () => {
  it("tracks both harness copies once per project and S05 updates every complete tree", async () => {
    const fixture = await legacyFixture();
    const before = await Promise.all(fixture.projects.map(({ root }) => treeDigest(root)));
    // The source already changed before startup: the base must come from the old installed copy.
    const updated = "---\nname: demo\n---\n# Source update\n";
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), updated);
    await writeFile(
      join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/payload.bin"),
      Buffer.from([7, 0, 9]),
    );
    const operations = await registerOperations(fixture, fixture.history);
    const state = await readyRelationships(fixture);
    expect(state.skills).toHaveLength(2);
    expect(state.uses).toHaveLength(4);
    for (const project of fixture.projects) {
      const skills = state.skills.filter(({ locations }) =>
        locations.some(({ projectId }) => projectId === project.id),
      );
      expect(skills).toHaveLength(1);
      expect(state.uses.filter(({ skillId }) => skillId === skills[0]!.skillId)).toHaveLength(2);
    }
    expect(await Promise.all(fixture.projects.map(({ root }) => treeDigest(root)))).toEqual(before);
    expect(await fixture.bindingStore.read()).toMatchObject({ bindings: fixture.legacyBindings });
    const receipts = await bridgeReceipts(fixture);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: "applied", displayTarget: "Omni now tracks 4 copies", actions: [] });
    await operations.skillManagement.initialize();
    expect(await readyRelationships(fixture)).toEqual(state);
    expect(await bridgeReceipts(fixture)).toEqual(receipts);

    const preview = await operations.skillManagement.preview(
      { kind: "maintain-current", source: fixture.sourceRef },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("S05 preview was not ready.");
    expect(preview.propagation?.targets.map(({ state }) => state)).toEqual(Array(4).fill("eligible"));
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("applied");
    for (const project of fixture.projects)
      for (const folder of [projectSkill, claudeSkill]) {
        expect(await readFile(join(project.root, folder, "SKILL.md"), "utf8")).toBe(updated);
        expect(await readFile(join(project.root, folder, "support/payload.bin"))).toEqual(Buffer.from([7, 0, 9]));
      }
  });

  it("retains handwritten support-file edits and creates no use for a missing copy", async () => {
    const fixture = await legacyFixture();
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "My local notes.\n");
    await rm(join(fixture.projects[1]!.root, claudeSkill), { recursive: true });
    const operations = await registerOperations(fixture, fixture.history);
    const state = await readyRelationships(fixture);
    expect(state.uses).toHaveLength(3);
    const edited = state.uses.find(({ bindingId }) => bindingId === "legacy-0-codex");
    expect(edited).toMatchObject({ baseUnavailable: true });
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "notes.md"), "Updated upstream.\n");
    const preview = await operations.skillManagement.preview(
      { kind: "maintain-current", source: fixture.sourceRef },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("S05 preview was not ready.");
    expect(preview.propagation?.targets.find(({ bindingId }) => bindingId === edited!.bindingId)?.state).toBe(
      "retained-local",
    );
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.propagation?.targets.find(({ bindingId }) => bindingId === edited!.bindingId)?.result).toBe(
      "retained-local",
    );
    expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"), "utf8")).toBe("My local notes.\n");
  });

  it("restores only created uses while preserving unrelated metadata and project bytes", async () => {
    const fixture = await legacyFixture();
    const operations = await registerOperations(fixture, fixture.history);
    const bridge = (await bridgeReceipts(fixture))[0]!;
    const state = await readyRelationships(fixture);
    const unrelated = { ...state.skills[0]!, label: "A later label" };
    await fixture.relationships.compareAndSave(
      state.revision,
      state.skills.map((skill) => (skill.skillId === unrelated.skillId ? unrelated : skill)),
    );
    const unrelatedLocation = {
      projectId: fixture.project.id,
      harnessId: "codex" as const,
      folderPath: ".agents/skills/unrelated",
    };
    const otherSkill = {
      skillId: randomUUID(),
      label: "Other skill",
      evidence: "individual" as const,
      locations: [unrelatedLocation],
    };
    const otherUse = {
      skillId: otherSkill.skillId,
      bindingId: "unrelated-binding",
      location: unrelatedLocation,
      source: { ...fixture.sourceRef, artifactPath: "skills/unrelated" },
      baseRevisionId: randomUUID(),
    };
    await fixture.relationships.updateUsesExact(
      undefined,
      [{ skillId: otherSkill.skillId, location: unrelatedLocation, after: otherUse }],
      [{ skillId: otherSkill.skillId, after: otherSkill }],
    );
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Later project edit.\n");
    const before = await Promise.all(fixture.projects.map(({ root }) => treeDigest(root)));
    const preview = await operations.skillManagement.preview(
      { kind: "restore", operationId: bridge.operationId },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Bridge restore was not ready.");
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("restored");
    const after = await readyRelationships(fixture);
    expect(after.uses).toEqual([otherUse]);
    expect(after.skills.find(({ skillId }) => skillId === unrelated.skillId)?.label).toBe("A later label");
    expect(await Promise.all(fixture.projects.map(({ root }) => treeDigest(root)))).toEqual(before);
    expect((await bridgeReceipts(fixture))[0]?.restored).toBe(true);
  });

  it("does not record an operation at startup without legacy Bindings", async () => {
    const fixture = await seedFixture();
    await registerOperations(fixture);
    const history = await createOperationStore(join(fixture.userDataPath, "omni", "operations.json")).read();
    expect(history).toEqual({ status: "ready", receipts: [] });
  });

  it("bridges a legacy assignment immediately and blocks a second legacy writer", async () => {
    const fixture = await legacyFixture();
    await rm(join(fixture.projectRoot, projectSkill), { recursive: true });
    await rm(join(fixture.projectRoot, claudeSkill), { recursive: true });
    const operations = await registerOperations(fixture, fixture.history);
    const preview = (await handlers.get(APPLY_IPC_CHANNELS.preview)!(
      {},
      {
        projectId: fixture.project.id,
        grantHandle: fixture.project.grantHandle,
        sourceGrantHandle: fixture.source.grantHandle,
      },
    )) as { status: string; planId: string };
    expect(preview.status).toBe("ready");
    const applied = (await handlers.get(APPLY_IPC_CHANNELS.run)!({}, { planId: preview.planId, resolutions: [] })) as {
      status: string;
    };
    expect(applied.status).toBe("applied");
    expect((await readyRelationships(fixture)).uses).toHaveLength(4);
    const legacyList = (await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})) as { bindings: unknown[] };
    expect(legacyList.bindings).toEqual([]);
    const repeated = await operations.previewOperation({
      kind: "apply-plan",
      projectId: fixture.project.id,
      bindingIds: ["legacy-0-codex"],
    });
    expect(repeated.status).toBe("blocked");
  });

  it.each(["document hash", "absent hash", "oversized support file"])(
    "retains a copy with incomplete ownership evidence: %s",
    async (caseName) => {
      const fixture = await legacyFixture();
      const binding = fixture.legacyBindings[0]!;
      const documentHash = createHash("sha256")
        .update(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md")))
        .digest("hex");
      if (caseName === "oversized support file")
        await writeFile(join(fixture.projectRoot, projectSkill, "support/large.bin"), Buffer.alloc(1024 * 1024 + 1));
      else
        await fixture.bindingStore.updateExact([
          {
            bindingId: binding.bindingId,
            expected: binding,
            next: { ...binding, ownedHash: caseName === "document hash" ? documentHash : undefined },
          },
        ]);
      await registerOperations(fixture, fixture.history);
      const state = await readyRelationships(fixture);
      expect(state.uses.find(({ bindingId }) => bindingId === binding.bindingId)).toMatchObject({
        baseUnavailable: true,
      });
    },
  );

  it("uses a complete apply receipt to verify support and binary files when ownedHash covers only SKILL.md", async () => {
    const fixture = await legacyFixture();
    const binding = fixture.legacyBindings[0]!;
    const files = await Promise.all(
      ["SKILL.md", "notes.md", "support/payload.bin"].map(async (path) => ({
        relativePath: `${projectSkill}/${path}`,
        contentHash: createHash("sha256")
          .update(await readFile(join(fixture.projectRoot, projectSkill, path)))
          .digest("hex"),
      })),
    );
    const updatedBinding = { ...binding, artifactPath: `${sourceSkill}/SKILL.md`, ownedHash: files[0]!.contentHash };
    await fixture.bindingStore.updateExact([{ bindingId: binding.bindingId, expected: binding, next: updatedBinding }]);
    await fixture.history.append({
      operationId: randomUUID(),
      kind: "apply-plan",
      status: "applied",
      appliedAt: "2026-10-11T00:00:00.000Z",
      displayTarget: "Legacy assignment",
      actions: [],
      git: { mode: "disabled" },
      registered: null,
      project: { id: fixture.project.id },
      bindings: [{ bindingId: binding.bindingId, after: updatedBinding }],
      files,
    });
    const operations = await registerOperations(fixture, fixture.history);
    const use = (await readyRelationships(fixture)).uses.find(({ bindingId }) => bindingId === binding.bindingId)!;
    expect(use.baseUnavailable).toBeUndefined();
    expect(use.source).toEqual(fixture.sourceRef);
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "notes.md"), "Receipt-proven update.\n");
    const preview = await operations.skillManagement.preview(
      { kind: "maintain-current", source: fixture.sourceRef },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status === "ready")
      expect(preview.propagation?.targets.find(({ bindingId }) => bindingId === binding.bindingId)?.state).toBe(
        "eligible",
      );
  });

  it("refuses restore after a created use changes and leaves all other uses untouched", async () => {
    const fixture = await legacyFixture();
    const operations = await registerOperations(fixture, fixture.history);
    const bridge = (await bridgeReceipts(fixture))[0]!;
    const preview = await operations.skillManagement.preview(
      { kind: "restore", operationId: bridge.operationId },
      { kind: "desktop" },
    );
    if (preview.status !== "ready") throw new Error("Restore preview was not ready.");
    const state = await readyRelationships(fixture);
    const use = state.uses[0]!;
    await fixture.relationships.updateUsesExact(state.revision, [
      { skillId: use.skillId, location: use.location, before: use, after: { ...use, baseRevisionId: randomUUID() } },
    ]);
    const before = await readyRelationships(fixture);
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("failed");
    expect(await readyRelationships(fixture)).toEqual(before);
    const fresh = await operations.skillManagement.preview(
      { kind: "restore", operationId: bridge.operationId },
      { kind: "desktop" },
    );
    expect(fresh.status).toBe("blocked");
  });

  it("finalizes an interrupted bridge receipt at the next startup without duplicating uses or history", async () => {
    const fixture = await legacyFixture();
    let interrupted = false;
    const history = {
      ...fixture.history,
      async append(receipt: OperationReceipt) {
        if (receipt.legacyBridge?.phase === "applied" && !interrupted) {
          interrupted = true;
          throw new Error("Simulated terminal receipt failure.");
        }
        return fixture.history.append(receipt);
      },
    };
    const initial = await registerOperations(fixture, history);
    expect(initial.skillManagement.readLegacyBridgeDiagnostic?.()?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "metadata-save-unavailable" })]),
    );
    expect((await readyRelationships(fixture)).uses).toHaveLength(4);
    expect((await bridgeReceipts(fixture))[0]).toMatchObject({ status: "failed", legacyBridge: { phase: "prepared" } });
    await registerOperations(fixture, fixture.history);
    expect((await readyRelationships(fixture)).uses).toHaveLength(4);
    expect(await bridgeReceipts(fixture)).toHaveLength(1);
    expect((await bridgeReceipts(fixture))[0]).toMatchObject({ status: "applied", legacyBridge: { phase: "applied" } });
  });

  it("lets explicit exact adoption establish a missing legacy base after fresh complete equality", async () => {
    const fixture = await legacyFixture();
    const binding = fixture.legacyBindings[0]!;
    await fixture.bindingStore.updateExact([
      { bindingId: binding.bindingId, expected: binding, next: { ...binding, ownedHash: undefined } },
    ]);
    const operations = await registerOperations(fixture, fixture.history);
    const use = (await readyRelationships(fixture)).uses.find(({ bindingId }) => bindingId === binding.bindingId)!;
    expect(use.baseUnavailable).toBe(true);
    const preview = await operations.skillManagement.preview(
      {
        kind: "reconcile",
        request: { choice: "adopt-exact", skillId: use.skillId, source: fixture.sourceRef, locations: [use.location] },
      },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Exact adoption was not ready.");
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("applied");
    expect(
      (await readyRelationships(fixture)).uses.find(({ bindingId }) => bindingId === binding.bindingId)
        ?.baseUnavailable,
    ).toBeUndefined();
    const restore = await operations.skillManagement.preview(
      { kind: "restore", operationId: result.operationId },
      { kind: "desktop" },
    );
    expect(restore.status).toBe("ready");
    if (restore.status !== "ready") throw new Error("Adoption restore was not ready.");
    expect(
      (
        await operations.skillManagement.apply(restore.intentId, {
          kind: "desktop",
          effectFingerprint: restore.effectFingerprint,
          approvedAt: new Date().toISOString(),
        })
      ).status,
    ).toBe("restored");
    expect(
      (await readyRelationships(fixture)).uses.find(({ bindingId }) => bindingId === binding.bindingId)
        ?.baseUnavailable,
    ).toBe(true);
  });

  it("recovers an interrupted inverse without rebridging the reserved locations at restart", async () => {
    const fixture = await legacyFixture();
    let interrupted = false;
    const history = {
      ...fixture.history,
      async append(receipt: OperationReceipt) {
        if (receipt.kind === "restore-apply" && !interrupted) {
          interrupted = true;
          throw new Error("Simulated inverse receipt failure.");
        }
        return fixture.history.append(receipt);
      },
    };
    const operations = await registerOperations(fixture, history);
    const bridge = (await bridgeReceipts(fixture))[0]!;
    const preview = await operations.skillManagement.preview(
      { kind: "restore", operationId: bridge.operationId },
      { kind: "desktop" },
    );
    if (preview.status !== "ready") throw new Error("Bridge restore preview was not ready.");
    const inverse = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(inverse.status).toBe("recovery-required");
    expect((await readyRelationships(fixture)).uses).toEqual([]);
    const reopened = await registerOperations(fixture, fixture.history);
    expect((await readyRelationships(fixture)).uses).toEqual([]);
    const recovery = await reopened.skillManagement.preview(
      { kind: "restore", operationId: inverse.intentId },
      { kind: "desktop" },
    );
    expect(recovery.status).toBe("ready");
    if (recovery.status !== "ready") throw new Error("Interrupted inverse recovery was not ready.");
    expect(
      (
        await reopened.skillManagement.apply(recovery.intentId, {
          kind: "desktop",
          effectFingerprint: recovery.effectFingerprint,
          approvedAt: new Date().toISOString(),
        })
      ).status,
    ).toBe("restored");
    expect(await bridgeReceipts(fixture)).toHaveLength(1);
    expect((await bridgeReceipts(fixture))[0]?.restored).toBe(true);
  });
});
