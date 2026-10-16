import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSkillRemovalAdapter } from "../../src/main/skill-management/removal";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { createMainSkillManagementService } from "../../src/main/skill-management/service";
import { bindingsFilePath, createBindingsStore } from "../../src/main/bindings-store";
import { applyInitial, setup, type Binding } from "./apply-ipc-helpers";

async function makeService(fixture: Awaited<ReturnType<typeof setup>>) {
  const { createOperationStore } = await import("../../src/main/operation-store");
  const operationStore = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
  const adapter = createSkillRemovalAdapter({
    registry: fixture.registry,
    bindings: fixture.bindings,
    applyRestore: fixture.applyRestore,
    operationStore,
  });
  const service = createMainSkillManagementService({
    writeSkill: {} as never,
    restore: {} as never,
    operationStore,
    journal: createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations")),
    removal: adapter,
    applyRestore: fixture.applyRestore,
  });
  return { adapter, operationStore, service };
}

describe("skill management removal adapter", () => {
  it("removes the recorded project revision after its marketplace source advances", async () => {
    const fixture = await setup({ commitChanges: false });
    await applyInitial(fixture);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "source v2\n");
    const { adapter } = await makeService(fixture);
    const preview = await adapter.preview(
      { kind: "remove", bindingIds: [fixture.binding.bindingId] },
      "remove-old-revision",
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.reason);
    expect(await adapter.apply("remove-old-revision", preview)).toMatchObject({
      status: "applied",
      targets: [{ status: "removed" }],
    });
    expect(await readFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "utf8")).toBe("source v2\n");
  });

  it("withholds removal when an unaccepted local change happens to match a newer source", async () => {
    const fixture = await setup({ commitChanges: false });
    await applyInitial(fixture);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "source v2\n");
    const local = join(fixture.projectRoot, ".claude/skills/demo/SKILL.md");
    await writeFile(local, "source v2\n");
    const { adapter } = await makeService(fixture);
    expect(
      await adapter.preview({ kind: "remove", bindingIds: [fixture.binding.bindingId] }, "remove-unaccepted-copy"),
    ).toMatchObject({ status: "blocked", details: [expect.objectContaining({ code: "target-modified" })] });
    expect(await readFile(local, "utf8")).toBe("source v2\n");
  });

  it("removes a managed target through Changes and restores it after reopening the service", async () => {
    const fixture = await setup({ commitChanges: false });
    await applyInitial(fixture);
    const bindingsBeforeRemoval = await fixture.bindings.readBindings();
    if (bindingsBeforeRemoval.status !== "ready") throw new Error("Expected the fixture binding to be available.");
    const originalBinding = bindingsBeforeRemoval.bindings[0]!;
    const { adapter, service } = await makeService(fixture);
    await service.initialize();

    const preview = await service.preview(
      { kind: "remove", bindingIds: [fixture.binding.bindingId] },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Expected a ready removal preview.");
    expect(preview.steps[0]?.files.map((file) => file.relativePath).sort()).toEqual([
      ".claude/skills/demo/SKILL.md",
      ".claude/skills/demo/notes.md",
    ]);
    expect(preview.steps[0]?.files.find((file) => file.relativePath.endsWith("/notes.md"))?.diff).toContain("-notes");
    expect(preview.steps[0]?.bindingEffects).toEqual([
      {
        bindingId: fixture.binding.bindingId,
        before: expect.objectContaining({ bindingId: fixture.binding.bindingId }),
      },
    ]);

    const removed = await service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(removed).toMatchObject({
      status: "applied",
      source: { status: "unchanged" },
      targets: [{ status: "removed" }],
    });
    await expect(stat(join(fixture.projectRoot, ".claude/skills/demo"))).rejects.toThrow();
    expect(await fixture.bindings.readBindings()).toMatchObject({ status: "ready", bindings: [] });

    const repeated = await adapter.preview(
      { kind: "remove", bindingIds: [fixture.binding.bindingId] },
      "remove-replay",
    );
    expect(repeated.status).toBe("ready");
    if (repeated.status !== "ready")
      throw new Error("A receipt-backed removal replay should be reviewable as a no-op.");
    expect(repeated.steps.every((step) => step.files.length === 0)).toBe(true);
    expect(await adapter.apply("remove-replay", repeated)).toMatchObject({
      status: "no-op",
      targets: [{ status: "no-op" }],
    });

    const unrelated: Binding = { ...fixture.binding, bindingId: "unrelated-binding", harnessId: "codex" };
    expect(await fixture.bindings.saveBindings({ bindings: [unrelated] })).toMatchObject({ status: "ready" });
    const reopened = (await makeService(fixture)).service;
    await reopened.initialize();
    const restorePreview = await reopened.preview(
      { kind: "restore", operationId: removed.receiptIds[0]! },
      { kind: "desktop" },
    );
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") throw new Error("Expected a ready removal restore preview.");
    const restored = await reopened.apply(restorePreview.intentId, {
      kind: "desktop",
      effectFingerprint: restorePreview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });

    expect(restored).toMatchObject({
      status: "restored",
      source: { status: "unchanged" },
      targets: [{ status: "restored" }],
    });
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
    expect(await fixture.bindings.readBindings()).toMatchObject({
      status: "ready",
      bindings: expect.arrayContaining([originalBinding, unrelated]),
    });
  });

  it("blocks unknown binding ids and withholds restore after a support file is recreated", async () => {
    const fixture = await setup({ commitChanges: false });
    await applyInitial(fixture);
    const { adapter, service } = await makeService(fixture);
    await service.initialize();

    expect(await adapter.preview({ kind: "remove", bindingIds: ["unknown-binding"] }, "remove-unknown")).toMatchObject({
      status: "blocked",
      details: [expect.objectContaining({ code: "binding-unavailable" })],
    });
    const preview = await service.preview(
      { kind: "remove", bindingIds: [fixture.binding.bindingId] },
      { kind: "desktop" },
    );
    if (preview.status !== "ready") throw new Error("Expected a ready removal preview.");
    const removed = await service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    await mkdir(join(fixture.projectRoot, ".claude/skills/demo"), { recursive: true });
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/notes.md"), "changed after removal\n", "utf8");

    const restore = await service.preview(
      { kind: "restore", operationId: removed.receiptIds[0]! },
      { kind: "desktop" },
    );
    expect(restore).toMatchObject({ status: "blocked", details: [expect.objectContaining({ code: "restore-drift" })] });
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/notes.md"), "utf8")).toBe(
      "changed after removal\n",
    );
    expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toMatchObject({
      status: "ready",
      bindings: [],
    });
  });

  it("blocks local support-file drift with the exact path and keeps the binding", async () => {
    const fixture = await setup({ commitChanges: false });
    await applyInitial(fixture);
    const supportPath = join(fixture.projectRoot, ".claude/skills/demo/notes.md");
    await writeFile(supportPath, "my support edit\n", "utf8");
    const { adapter } = await makeService(fixture);

    const preview = await adapter.preview(
      { kind: "remove", bindingIds: [fixture.binding.bindingId] },
      "remove-support-drift",
    );

    expect(preview).toMatchObject({
      status: "blocked",
      details: [expect.objectContaining({ code: "target-modified", relativePath: ".claude/skills/demo/notes.md" })],
    });
    expect(await readFile(supportPath, "utf8")).toBe("my support edit\n");
    expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toMatchObject({
      status: "ready",
      bindings: [expect.objectContaining({ bindingId: fixture.binding.bindingId })],
    });
  });

  it("reports unavailable project grants before preparing a removal", async () => {
    const fixture = await setup({ commitChanges: false });
    await applyInitial(fixture);
    vi.spyOn(fixture.registry, "getGrantForEntry").mockResolvedValue(undefined);
    const { adapter } = await makeService(fixture);

    const preview = await adapter.preview(
      { kind: "remove", bindingIds: [fixture.binding.bindingId] },
      "remove-no-grant",
    );

    expect(preview).toMatchObject({
      status: "blocked",
      details: [expect.objectContaining({ code: "project-grant-unavailable" })],
    });
    expect(await stat(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"))).toBeTruthy();
  });

  it("removes only the two selected harness bindings", async () => {
    const fixture = await setup({ commitChanges: false });
    await applyInitial(fixture);
    const codexPath = join(fixture.projectRoot, ".agents/skills/demo");
    await mkdir(codexPath, { recursive: true });
    await writeFile(join(codexPath, "SKILL.md"), "v1\n", "utf8");
    await writeFile(join(codexPath, "notes.md"), "notes\n", "utf8");
    const current = await fixture.bindings.readBindings();
    if (current.status !== "ready") throw new Error("Expected current binding state.");
    const codexBinding: Binding = {
      ...current.bindings[0]!,
      bindingId: "codex-binding",
      kind: "skill",
      harnessId: "codex",
    };
    expect(await fixture.bindings.saveBindings({ bindings: [...current.bindings, codexBinding] })).toMatchObject({
      status: "ready",
    });
    const { adapter } = await makeService(fixture);

    const preview = await adapter.preview(
      { kind: "remove", bindingIds: [fixture.binding.bindingId, codexBinding.bindingId] },
      "remove-two-bindings",
    );
    if (preview.status !== "ready")
      throw new Error(`Expected both selected bindings to be ready for removal: ${JSON.stringify(preview)}`);
    expect(preview.steps).toHaveLength(2);
    await adapter.prepare("remove-two-bindings", preview);
    const result = await adapter.apply("remove-two-bindings", preview);

    expect(result).toMatchObject({ status: "applied", targets: [{ status: "removed" }, { status: "removed" }] });
    await expect(stat(join(fixture.projectRoot, ".claude/skills/demo"))).rejects.toThrow();
    await expect(stat(codexPath)).rejects.toThrow();
    expect(await fixture.bindings.readBindings()).toMatchObject({ status: "ready", bindings: [] });
  });

  it("keeps later removal targets untouched when an earlier target succeeds and a later one blocks", async () => {
    const fixture = await setup({ commitChanges: false });
    await applyInitial(fixture);
    const codexPath = join(fixture.projectRoot, ".agents/skills/demo");
    await mkdir(codexPath, { recursive: true });
    await writeFile(join(codexPath, "SKILL.md"), "v1\n", "utf8");
    await writeFile(join(codexPath, "notes.md"), "notes\n", "utf8");
    const current = await fixture.bindings.readBindings();
    if (current.status !== "ready") throw new Error("Expected current binding state.");
    const codexBinding: Binding = {
      ...current.bindings[0]!,
      bindingId: "codex-binding",
      kind: "skill",
      harnessId: "codex",
    };
    await fixture.bindings.saveBindings({ bindings: [...current.bindings, codexBinding] });
    const base = await makeService(fixture);
    let calls = 0;
    const bridge = {
      ...fixture.applyRestore,
      runRemove: async (request: Parameters<typeof fixture.applyRestore.runRemove>[0]) => {
        calls += 1;
        if (calls === 2)
          return { status: "blocked" as const, reason: "target-unreadable", diagnostic: ".codex/skills/demo/notes.md" };
        return fixture.applyRestore.runRemove(request);
      },
    };
    const adapter = createSkillRemovalAdapter({
      registry: fixture.registry,
      bindings: fixture.bindings,
      applyRestore: bridge,
      operationStore: base.operationStore,
    });
    const preview = await adapter.preview(
      { kind: "remove", bindingIds: [fixture.binding.bindingId, codexBinding.bindingId] },
      "remove-partial",
    );
    if (preview.status !== "ready")
      throw new Error(`Expected both selected bindings to be reviewable: ${JSON.stringify(preview)}`);

    const result = await adapter.apply("remove-partial", preview);

    expect(result).toMatchObject({
      status: "partial",
      targets: [
        { bindingId: fixture.binding.bindingId, status: "removed" },
        { bindingId: codexBinding.bindingId, status: "failed" },
      ],
    });
    await expect(stat(join(fixture.projectRoot, ".claude/skills/demo"))).rejects.toThrow();
    expect(await readFile(join(codexPath, "SKILL.md"), "utf8")).toBe("v1\n");
    expect(await fixture.bindings.readBindings()).toMatchObject({
      status: "ready",
      bindings: [expect.objectContaining({ bindingId: codexBinding.bindingId })],
    });
  });
});
