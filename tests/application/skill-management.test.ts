import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSkillManagementService,
  type SkillEffectDraft,
  type SkillManagementEffects,
} from "../../src/application/skill-management";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import type { SkillActor, SkillIntent, SkillResult } from "../../src/shared/skill-management-ipc";

const roots: string[] = [];
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

async function journal(): Promise<ReturnType<typeof createSkillOperationJournal>> {
  const root = await mkdtemp(join(tmpdir(), "omni-skill-service-"));
  roots.push(root);
  return createSkillOperationJournal(join(root, "omni", "skill-operations"));
}

function draft(content: string, planId: string, sourceId = "source-a"): SkillEffectDraft {
  const intent = {
    kind: "write" as const,
    request: {
      kind: "write-skill" as const,
      sourceId: "source-a",
      packageId: "packages/tools",
      mode: "create" as const,
      folderName: "release-notes",
      files: [{ path: "SKILL.md", content }],
    },
  };
  const file = {
    rootId: `source:${sourceId}`,
    relativePath: "packages/tools/skills/release-notes/SKILL.md",
    change: "add" as const,
    afterHash: hash(content),
  };
  return {
    status: "ready",
    planId,
    scope: { sourceId, packageId: "packages/tools", targets: [] },
    steps: [
      {
        stepId: "source",
        scope: { sourceId, packageId: "packages/tools", targets: [] },
        plan: {
          planId,
          kind: "write-skill",
          displayTarget: "packages/tools",
          actions: [],
          git: { mode: "unavailable", warnings: [] },
        },
        bindingEffects: [],
        files: [file],
      },
    ],
    fingerprint: { scope: { sourceId, packageId: "packages/tools", targets: [] }, files: [file], bindings: [] },
    backupReferences: [{ rootId: `source:${sourceId}`, path: `backups/${planId}` }],
  };
}

type TestEffects = SkillManagementEffects & {
  apply: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  setContent(value: string): void;
};

function makeEffects(sourceId = "source-a"): TestEffects {
  let content = "# A\n";
  let sequence = 0;
  return {
    preview: vi.fn(async (_intent: SkillIntent, _actor: SkillActor) => draft(content, `plan-${++sequence}`, sourceId)),
    prepare: vi.fn(async () => undefined),
    validateAuthorization: vi.fn(async () => undefined),
    apply: vi.fn(async (intentId): Promise<SkillResult> => ({
      intentId,
      operationId: intentId,
      status: "applied",
      source: { status: "created", sourceId },
      targets: [],
      receiptIds: [`receipt-${sequence}`],
      issues: [],
      recoveryAvailable: true,
    })),
    setContent(value: string): void {
      content = value;
    },
  } as TestEffects;
}

const intent = {
  kind: "write" as const,
  request: {
    kind: "write-skill" as const,
    sourceId: "source-a",
    packageId: "packages/tools",
    mode: "create" as const,
    folderName: "release-notes",
    files: [{ path: "SKILL.md", content: "# A\n" }],
  },
};
const actor: SkillActor = { kind: "desktop" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("skill management application boundary", () => {
  it("holds the scope when a failed adapter cannot prove that rollback completed", async () => {
    const store = await journal();
    const effects = makeEffects();
    effects.apply.mockResolvedValue({
      status: "failed",
      source: { status: "failed", sourceId: "source-a" },
      targets: [],
      receiptIds: ["failed-child"],
      issues: [],
      recoveryAvailable: true,
    });
    const service = createSkillManagementService({ effects, journal: store, createId: () => "unverified-rollback" });
    const preview = await service.preview(intent, actor);
    if (preview.status !== "ready") throw new Error("Expected preview.");
    const result = await service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: "2026-10-07T10:00:00.000Z",
    });
    expect(result).toMatchObject({
      status: "recovery-required",
      source: { status: "unknown" },
      receiptIds: ["failed-child"],
    });
    expect(await store.read(preview.intentId)).toMatchObject({
      status: "ready",
      record: { status: "recovery-required", steps: [{ receiptId: "failed-child" }] },
    });
  });

  it("keeps the completed target receipt when the next target is interrupted", async () => {
    const store = await journal();
    const effects = makeEffects();
    const original = draft("# A\n", "plan-a");
    const steps = ["project-a", "project-b"].map((projectId) => ({
      ...original.steps[0],
      stepId: projectId,
      scope: { targets: [{ projectId, harnessId: "codex" as const, bindingId: `binding-${projectId}` }] },
      bindingEffects: [],
    }));
    effects.preview = async () => ({
      ...original,
      scope: { targets: steps.flatMap((step) => step.scope.targets) },
      steps,
    });
    effects.apply = vi.fn(async (_id, _intent, _actor, _approval, _effect, progress) => {
      await progress({ stepId: "project-a", status: "applied", receiptId: "receipt-a" });
      await progress({ stepId: "project-b", status: "applying" });
      throw new Error("interrupted");
    });
    const service = createSkillManagementService({ effects, journal: store, createId: () => "interrupted-targets" });
    const preview = await service.preview(intent, actor);
    if (preview.status !== "ready") throw new Error("Expected a ready preview.");
    const result = await service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: "2026-10-07T10:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "recovery-required", receiptIds: ["receipt-a"] });
    const saved = await store.read(preview.intentId);
    expect(saved).toMatchObject({
      status: "ready",
      record: {
        steps: [
          { stepId: "project-a", status: "applied", receiptId: "receipt-a" },
          { stepId: "project-b", status: "applying" },
        ],
      },
    });
  });

  it("reports durable progress as active while the operation is still running", async () => {
    const effects = makeEffects();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applying = new Promise<void>((resolve) => {
      started = resolve;
    });
    effects.apply = vi.fn(
      async (
        _id,
        _intent,
        _actor,
        _approval,
        _effect,
        progress,
      ): Promise<import("../../src/application/skill-management").SkillEffectOutcome> => {
        await progress({ stepId: "source", status: "applying" });
        started();
        await pending;
        return {
          status: "applied",
          source: { status: "created", sourceId: "source-a" },
          targets: [],
          receiptIds: [],
          issues: [],
          recoveryAvailable: false,
        };
      },
    );
    const service = createSkillManagementService({
      effects,
      journal: await journal(),
      createId: () => "live-operation",
    });
    const preview = await service.preview(intent, actor);
    if (preview.status !== "ready") throw new Error("Expected preview.");
    const result = service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: "2026-10-07T10:00:00.000Z",
    });
    await applying;
    const live = await service.readResult(preview.intentId);
    release();
    await result;
    expect(live).toMatchObject({ status: "applying", issues: [], recoveryAvailable: false });
  });

  it("withholds a new write on a scope awaiting recovery after restart", async () => {
    const store = await journal();
    const first = createSkillManagementService({
      effects: makeEffects(),
      journal: store,
      createId: () => "interrupted-a",
    });
    const preview = await first.preview(intent, actor);
    if (preview.status !== "ready") throw new Error("Expected a ready preview.");
    const saved = await store.read(preview.intentId);
    if (saved.status !== "ready") throw new Error("Expected a saved operation.");
    await store.write({ ...saved.record, status: "applying" });

    const effects = makeEffects();
    const reopened = createSkillManagementService({ effects, journal: store, createId: () => "new-b" });
    await reopened.initialize();
    await expect(reopened.readResult("interrupted-a")).resolves.toMatchObject({ status: "recovery-required" });
    const next = await reopened.preview(intent, actor);
    if (next.status !== "ready") throw new Error("Expected a reviewable preview.");
    await expect(
      reopened.apply(next.intentId, {
        kind: "desktop",
        effectFingerprint: next.effectFingerprint,
        approvedAt: "2026-10-07T10:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      issues: [expect.objectContaining({ code: "scope-recovery-required" })],
    });
    expect(effects.prepare).not.toHaveBeenCalled();
    expect(effects.apply).not.toHaveBeenCalled();

    const independentEffects = makeEffects("source-b");
    const independent = createSkillManagementService({
      effects: independentEffects,
      journal: store,
      createId: () => "independent-c",
    });
    await independent.initialize();
    const unrelated = await independent.preview(
      { ...intent, request: { ...intent.request, sourceId: "source-b" } },
      actor,
    );
    if (unrelated.status !== "ready") throw new Error("Expected an independent preview.");
    await expect(
      independent.apply(unrelated.intentId, {
        kind: "desktop",
        effectFingerprint: unrelated.effectFingerprint,
        approvedAt: "2026-10-07T10:00:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(independentEffects.apply).toHaveBeenCalledOnce();
  });

  it("reuses consent for the same effect and shares one concurrent result", async () => {
    const effects = makeEffects();
    const store = await journal();
    const service = createSkillManagementService({ effects, journal: store, createId: () => "intent-a" });
    const preview = await service.preview(intent, actor);
    if (preview.status !== "ready") throw new Error("Expected a ready preview.");
    await expect(service.refresh(preview.intentId, actor)).resolves.toMatchObject({
      status: "ready",
      effectFingerprint: preview.effectFingerprint,
    });
    expect(await store.read(preview.intentId)).toMatchObject({
      status: "ready",
      record: { backupReferences: [{ path: "backups/plan-2" }] },
    });
    const authorization = {
      kind: "desktop" as const,
      effectFingerprint: preview.effectFingerprint,
      approvedAt: "2026-10-07T10:00:00.000Z",
    };
    const results = await Promise.all([
      service.apply(preview.intentId, authorization),
      service.apply(preview.intentId, authorization),
    ]);

    expect(effects.apply).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    await expect(service.apply(preview.intentId, authorization)).resolves.toEqual(results[0]);
  });

  it("rejects an equal-length changed proposal as stale before effects", async () => {
    const effects = makeEffects();
    const service = createSkillManagementService({ effects, journal: await journal(), createId: () => "intent-b" });
    const preview = await service.preview(intent, actor);
    if (preview.status !== "ready") throw new Error("Expected a ready preview.");
    effects.setContent("# B\n");

    await expect(service.refresh(preview.intentId, actor)).resolves.toMatchObject({ status: "stale" });
    await expect(
      service.apply(preview.intentId, {
        kind: "desktop",
        effectFingerprint: preview.effectFingerprint,
        approvedAt: "2026-10-07T10:00:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "failed", issues: [expect.objectContaining({ code: "preview-expired" })] });
    expect("# A\n".length).toBe("# B\n".length);
    expect(effects.apply).not.toHaveBeenCalled();
  });

  it("records a backup failure and does not call the effect adapter", async () => {
    const effects = makeEffects();
    effects.prepare.mockRejectedValue(new Error("backup unavailable"));
    const service = createSkillManagementService({ effects, journal: await journal(), createId: () => "intent-c" });
    const preview = await service.preview(intent, actor);
    if (preview.status !== "ready") throw new Error("Expected a ready preview.");

    await expect(
      service.apply(preview.intentId, {
        kind: "desktop",
        effectFingerprint: preview.effectFingerprint,
        approvedAt: "2026-10-07T10:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      recoveryAvailable: false,
      issues: [expect.objectContaining({ code: "backup-failed" })],
    });
    expect(effects.apply).not.toHaveBeenCalled();
  });
});
