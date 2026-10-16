import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSkillAssignmentAdapter } from "../../src/main/skill-management/assignment";
import { createOperationStore } from "../../src/main/operation-store";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { createMainSkillManagementService } from "../../src/main/skill-management/service";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import type { SkillEffectDraft } from "../../src/application/skill-management";
import { bindingsFilePath, createBindingsStore } from "../../src/main/bindings-store";
import { setup } from "./apply-ipc-helpers";

describe("skill management assignment adapter", () => {
  it("assigns support files through the journal adapter, replays as a no-op, and restores exact bindings", async () => {
    const fixture = await setup({ commitChanges: false });
    const bindingStore = createBindingsStore(bindingsFilePath(fixture.userDataPath));
    const adapter = createSkillAssignmentAdapter({
      registry: fixture.registry,
      bindings: fixture.bindings,
      applyRestore: fixture.applyRestore,
    });
    const intent = {
      kind: "assign" as const,
      sourceId: fixture.source.id,
      packageId: "packages/tools",
      artifactPath: "skills/demo",
      targets: [{ projectId: fixture.project.id, harnessIds: ["claude-code"] as const }],
    };

    const preview = await adapter.preview(intent, "skill-assignment-one");
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Expected a ready assignment preview.");
    expect(preview.steps[0]?.files.map((file) => file.relativePath).sort()).toEqual([
      ".claude/skills/demo/SKILL.md",
      ".claude/skills/demo/notes.md",
    ]);
    expect(preview.steps[0]?.files.find((file) => file.relativePath.endsWith("/notes.md"))?.diff).toContain("+notes");
    expect(preview.steps[0]?.bindingEffects).toEqual([
      expect.objectContaining({
        bindingId: expect.stringMatching(/^preview-/u),
        after: expect.objectContaining({ ownedHash: expect.any(String) }),
      }),
    ]);
    await adapter.prepare("skill-assignment-one", preview);
    const applied = await adapter.apply("skill-assignment-one", preview);
    expect(applied).toMatchObject({
      status: "applied",
      targets: [{ projectId: fixture.project.id, status: "applied" }],
    });
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/notes.md"), "utf8")).toBe("notes\n");
    const installed = await bindingStore.read();
    expect(installed).toMatchObject({
      status: "ready",
      bindings: [expect.objectContaining({ ownedHash: expect.any(String) })],
    });

    const repeated = await adapter.preview(intent, "skill-assignment-two");
    expect(repeated.status).toBe("ready");
    if (repeated.status !== "ready") throw new Error("Expected the repeated assignment preview to be ready.");
    const noOp = await adapter.apply("skill-assignment-two", repeated);
    expect(noOp).toMatchObject({ status: "no-op", receiptIds: [], targets: [{ status: "no-op" }] });

    const restorePreview = await fixture.applyRestore.previewRestore({ operationId: applied.receiptIds[0] });
    if (restorePreview.status !== "ready")
      throw new Error(`Expected a ready assignment restore preview: ${JSON.stringify(restorePreview)}`);
    await expect(fixture.applyRestore.runRestore({ planId: restorePreview.planId })).resolves.toMatchObject({
      status: "applied",
    });
    await expect(stat(join(fixture.projectRoot, ".claude/skills/demo"))).rejects.toThrow();
    expect(await bindingStore.read()).toMatchObject({ status: "ready", bindings: [] });
    const receipts = await (
      await import("../../src/main/operation-store")
    )
      .createOperationStore(join(fixture.userDataPath, "omni/operations.json"))
      .read();
    expect(receipts.status).toBe("ready");
    if (receipts.status === "ready")
      expect(receipts.receipts.map((receipt) => receipt.kind).sort()).toEqual(["apply-plan", "restore-apply"]);
  });

  it("restores an assignment through the journaled Changes service", async () => {
    const fixture = await setup({ commitChanges: false });
    const adapter = createSkillAssignmentAdapter({
      registry: fixture.registry,
      bindings: fixture.bindings,
      applyRestore: fixture.applyRestore,
    });
    const intent = {
      kind: "assign" as const,
      sourceId: fixture.source.id,
      packageId: "packages/tools",
      artifactPath: "skills/demo",
      targets: [{ projectId: fixture.project.id, harnessIds: ["claude-code"] as const }],
    };
    const assignment = await adapter.preview(intent, "skill-assignment-journaled");
    if (assignment.status !== "ready") throw new Error("Expected a ready assignment preview.");
    await adapter.prepare("skill-assignment-journaled", assignment);
    const applied = await adapter.apply("skill-assignment-journaled", assignment);
    const operationId = applied.receiptIds[0];
    if (!operationId) throw new Error("Expected an assignment operation receipt.");

    const service = createMainSkillManagementService({
      writeSkill: {} as never,
      restore: {} as never,
      operationStore: createOperationStore(join(fixture.userDataPath, "omni/operations.json")),
      journal: createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations")),
      assignment: adapter,
      applyRestore: fixture.applyRestore,
    });
    await service.initialize();
    const preview = await service.preview({ kind: "restore", operationId }, { kind: "desktop" });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Expected a ready journaled restore preview.");
    const result = await service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result).toMatchObject({
      status: "restored",
      source: { status: "unchanged" },
      targets: [{ status: "restored", projectId: fixture.project.id }],
    });
    await expect(stat(join(fixture.projectRoot, ".claude/skills/demo"))).rejects.toThrow();
    expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toMatchObject({
      status: "ready",
      bindings: [],
    });
  });

  it("marks later selected targets skipped after an earlier project apply fails", async () => {
    const fixture = await setup({ commitChanges: false });
    const initial = createSkillAssignmentAdapter({
      registry: fixture.registry,
      bindings: fixture.bindings,
      applyRestore: fixture.applyRestore,
    });
    const intent = {
      kind: "assign" as const,
      sourceId: fixture.source.id,
      packageId: "packages/tools",
      artifactPath: "skills/demo",
      targets: [{ projectId: fixture.project.id, harnessIds: ["claude-code"] as const }],
    };
    const preview = await initial.preview(intent, "skill-assignment-partial");
    if (preview.status !== "ready") throw new Error("Expected a ready assignment preview.");
    const projects = ["project-one", "project-two", "project-three"];
    const steps = projects.map((projectId, index) => {
      const original = preview.steps[0]!;
      const binding = { ...fixture.binding, bindingId: `binding-${index}`, projectId };
      return {
        ...original,
        stepId: `step-${index}`,
        scope: {
          ...original.scope,
          targets: [{ projectId, harnessId: "claude-code" as const, bindingId: binding.bindingId }],
        },
        plan: { ...original.plan, planId: `plan-${index}` },
        bindingEffects: [{ bindingId: binding.bindingId, after: binding }],
      };
    });
    const effect = {
      ...preview,
      scope: { ...preview.scope, targets: steps.flatMap((step) => step.scope.targets) },
      steps,
    } as SkillEffectDraft;
    const appliedReceipt: OperationReceipt = {
      operationId: "receipt-one",
      kind: "apply-plan",
      status: "applied",
      appliedAt: new Date().toISOString(),
      displayTarget: "Project one",
      actions: [],
      git: { mode: "unavailable" },
      registered: null,
      project: { id: projects[0]! },
    };
    const bridge = {
      ...fixture.applyRestore,
      runManagedAssignment: vi.fn(async (planId: string) =>
        planId === "plan-1"
          ? { status: "blocked" as const, reason: "project-unavailable", diagnostic: "Project two is unavailable." }
          : { status: "applied" as const, receipt: appliedReceipt },
      ),
    };
    const adapter = createSkillAssignmentAdapter({
      registry: fixture.registry,
      bindings: fixture.bindings,
      applyRestore: bridge,
    });

    const result = await adapter.apply("skill-assignment-partial", effect);

    expect(result).toMatchObject({
      status: "partial",
      source: { status: "unchanged", sourceId: fixture.source.id },
      targets: [
        { projectId: "project-one", status: "applied" },
        { projectId: "project-two", status: "failed" },
        { projectId: "project-three", status: "skipped" },
      ],
    });
    expect(bridge.runManagedAssignment).toHaveBeenCalledTimes(2);
  });

  it("withholds an equal-content unbound project copy for an explicit decision", async () => {
    const fixture = await setup({ commitChanges: false });
    const targetRoot = join(fixture.projectRoot, ".claude/skills/demo");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, "SKILL.md"), "v1\n", "utf8");
    await writeFile(join(targetRoot, "notes.md"), "notes\n", "utf8");
    const adapter = createSkillAssignmentAdapter({
      registry: fixture.registry,
      bindings: fixture.bindings,
      applyRestore: fixture.applyRestore,
    });

    const preview = await adapter.preview(
      {
        kind: "assign",
        sourceId: fixture.source.id,
        packageId: "packages/tools",
        artifactPath: "skills/demo",
        targets: [{ projectId: fixture.project.id, harnessIds: ["claude-code"] }],
      },
      "skill-assignment-unbound-copy",
    );

    expect(preview).toMatchObject({ status: "needs-input", details: [{ code: "unbound-copy" }] });
    expect(await readFile(join(targetRoot, "SKILL.md"), "utf8")).toBe("v1\n");
    expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toMatchObject({
      status: "ready",
      bindings: [],
    });
  });

  it("withholds apply when a source support file changes after assignment preview", async () => {
    const fixture = await setup({ commitChanges: false });
    const adapter = createSkillAssignmentAdapter({
      registry: fixture.registry,
      bindings: fixture.bindings,
      applyRestore: fixture.applyRestore,
    });
    const intent = {
      kind: "assign" as const,
      sourceId: fixture.source.id,
      packageId: "packages/tools",
      artifactPath: "skills/demo",
      targets: [{ projectId: fixture.project.id, harnessIds: ["claude-code"] as const }],
    };
    const first = await adapter.preview(intent, "skill-assignment-initial");
    if (first.status !== "ready") throw new Error("Expected a ready initial assignment preview.");
    await adapter.prepare("skill-assignment-initial", first);
    await adapter.apply("skill-assignment-initial", first);

    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/notes.md"), "notes v2\n", "utf8");
    const preview = await adapter.preview(intent, "skill-assignment-source-drift");
    if (preview.status !== "ready") throw new Error("Expected a ready update preview.");
    await adapter.prepare("skill-assignment-source-drift", preview);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/notes.md"), "notes v3\n", "utf8");

    const result = await adapter.apply("skill-assignment-source-drift", preview);

    expect(result).toMatchObject({
      status: "failed",
      source: { status: "unchanged" },
      targets: [{ status: "failed" }],
    });
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/notes.md"), "utf8")).toBe("notes\n");
    const operations = await (
      await import("../../src/main/operation-store")
    )
      .createOperationStore(join(fixture.userDataPath, "omni/operations.json"))
      .read();
    expect(operations.status).toBe("ready");
    if (operations.status === "ready") expect(operations.receipts).toHaveLength(1);
  });
});
