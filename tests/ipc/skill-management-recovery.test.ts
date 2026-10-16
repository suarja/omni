import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillRecoveryAdapter } from "../../src/main/skill-management/recovery";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { createOperationStore } from "../../src/main/operation-store";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import type { SkillOperationJournalRecord } from "../../src/application/skill-management-journal";
import { hash, setup } from "./apply-ipc-helpers";

async function interrupted() {
  const fixture = await setup({ commitChanges: false });
  const journal = createSkillOperationJournal(join(fixture.userDataPath, "omni", "skill-operations"));
  const operationStore = createOperationStore(join(fixture.userDataPath, "omni", "operations.json"));
  const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  const backupPath = `backups/skill-intents/interrupted/${fixture.project.id}`;
  await mkdir(join(fixture.userDataPath, "omni", backupPath, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(fixture.userDataPath, "omni", backupPath, ".agents/skills/demo/SKILL.md"), "before\n");
  await mkdir(join(fixture.projectRoot, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(fixture.projectRoot, ".agents/skills/demo/SKILL.md"), "after\n");
  const scope = {
    targets: [
      { projectId: fixture.project.id, harnessId: "claude-code" as const, bindingId: fixture.binding.bindingId },
    ],
  };
  const effect = {
    stepId: "target",
    scope,
    bindingEffects: [
      {
        bindingId: fixture.binding.bindingId,
        before: fixture.binding,
        after: { ...fixture.binding, ownedHash: hash("after\n") },
      },
    ],
    files: [
      {
        rootId: fixture.project.id,
        relativePath: ".agents/skills/demo/SKILL.md",
        change: "change" as const,
        beforeHash: hash("before\n"),
        afterHash: hash("after\n"),
      },
      {
        rootId: fixture.project.id,
        relativePath: ".agents/skills/demo/notes.md",
        change: "add" as const,
        afterHash: hash("notes\n"),
      },
    ],
    plan: {
      planId: "original-plan",
      kind: "apply-plan" as const,
      displayTarget: "Test project",
      actions: [],
      git: { mode: "unavailable" as const, warnings: [] },
    },
  };
  const record: SkillOperationJournalRecord = {
    version: 1,
    intentId: "interrupted",
    actor: { kind: "desktop" },
    intent: {
      kind: "assign",
      sourceId: fixture.source.id,
      packageId: "packages/tools",
      targets: [{ projectId: fixture.project.id, harnessIds: ["codex"] }],
    },
    status: "recovery-required",
    effectFingerprint: hash("proposal"),
    effect: { planId: "original-plan", scope, steps: [effect] },
    backupReferences: [{ rootId: fixture.project.id, path: backupPath }],
    steps: [{ stepId: "target", status: "applying" }],
    createdAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
  };
  await bindings.save([fixture.binding]);
  await journal.write(record);
  return {
    fixture,
    journal,
    record,
    adapter: createSkillRecoveryAdapter({
      userDataPath: fixture.userDataPath,
      registry: fixture.registry,
      bindings,
      operationStore,
      journal,
    }),
  };
}

describe("interrupted skill recovery", () => {
  it("previews and restores only the touched files and bindings before retiring the recovery scope", async () => {
    const { adapter, record, journal, fixture } = await interrupted();
    const preview = await adapter.preview(record, "recovery-intent");
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Expected a recovery preview.");
    await adapter.prepare("recovery-intent", preview);
    const result = await adapter.apply("recovery-intent", preview, async () => undefined);
    expect(result.status).toBe("restored");
    expect(await readFile(join(fixture.projectRoot, ".agents/skills/demo/SKILL.md"), "utf8")).toBe("before\n");
    expect(await journal.read(record.intentId)).toMatchObject({
      status: "ready",
      record: { status: "terminal", result: { status: "restored" } },
    });
  });

  it("opens interrupted recovery through the shared service and releases only its original scope", async () => {
    const { record, fixture } = await interrupted();
    const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
    const operations = registerOperationsIpcHandlers(() => undefined, fixture.registry, {
      userDataPath: fixture.userDataPath,
      applyRestore: fixture.applyRestore,
      bindings: fixture.bindings,
    });
    await operations.skillManagement.initialize();
    expect(await operations.skillManagement.listRecoveries()).toMatchObject([
      {
        operationId: record.intentId,
        status: "recovery-required",
        targets: [expect.objectContaining({ status: "unknown" })],
      },
    ]);
    const preview = await operations.skillManagement.preview(
      { kind: "restore", operationId: record.intentId },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Expected recovery through the shared service.");
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: "2026-10-07T10:00:00.000Z",
    });
    expect(result.status).toBe("restored");
    expect(await operations.skillManagement.listRecoveries()).toEqual([]);
  });

  it("withholds recovery when a touched file has changed locally", async () => {
    const { adapter, record, fixture } = await interrupted();
    await writeFile(join(fixture.projectRoot, ".agents/skills/demo/SKILL.md"), "local edit\n");
    expect(await adapter.preview(record, "recovery-intent")).toMatchObject({
      status: "blocked",
      details: [expect.objectContaining({ code: "recovery-drift" })],
    });
    expect(await readFile(join(fixture.projectRoot, ".agents/skills/demo/SKILL.md"), "utf8")).toBe("local edit\n");
  });

  it("rechecks the approved hashes before starting recovery effects", async () => {
    const { adapter, record, fixture } = await interrupted();
    const preview = await adapter.preview(record, "recovery-intent");
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Expected a recovery preview.");
    await adapter.prepare("recovery-intent", preview);
    await writeFile(join(fixture.projectRoot, ".agents/skills/demo/SKILL.md"), "later edit\n");
    await expect(adapter.apply("recovery-intent", preview, async () => undefined)).rejects.toThrow(/changed/);
    expect(await readFile(join(fixture.projectRoot, ".agents/skills/demo/SKILL.md"), "utf8")).toBe("later edit\n");
  });
});
