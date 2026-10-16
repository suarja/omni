import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { applyPreview, previewIntent } from "./skill-resolution-fixture";
import {
  observedSkillId,
  projectSkill,
  registerOperations,
  seedFixture,
  sourcePackage,
  sourceSkill,
  treeDigest,
} from "./skill-adoption-fixture";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";

afterEach(() => vi.resetModules());

async function linkOneCopy(fixture: Awaited<ReturnType<typeof seedFixture>>, skillId: string) {
  await registerOperations(fixture);
  await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Local before.\r\n");
  const preview = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "link-canonical",
      skillId,
      source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") throw new Error("Expected a reviewed unbound link.");
  const result = await applyPreview(preview);
  expect(result.status).toBe("applied");
  return result;
}

it("restores from the child receipt after restart while the selected source is offline", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  const originalLocal = join(fixture.projectRoot, projectSkill);
  await writeFile(join(originalLocal, "notes.md"), "Local before.\r\n");
  const beforeLocal = async () => treeDigest(originalLocal);
  const localBefore = await beforeLocal();
  const linked = await linkOneCopy(fixture, skillId);
  const sourceBefore = await treeDigest(fixture.sourceRoot);
  const offlinePath = `${fixture.sourceRoot}-offline`;
  await rename(fixture.sourceRoot, offlinePath);
  try {
    await registerOperations(fixture);
    const childId = linked.receiptIds[0];
    expect(childId).toBeTruthy();
    const restore = await previewIntent({ kind: "restore", operationId: childId! });
    expect(restore.status, restore.status === "ready" ? "" : restore.reason).toBe("ready");
    if (restore.status !== "ready") throw new Error("Expected a child-receipt inverse preview.");
    const restored = await applyPreview(restore);
    expect(restored.status, JSON.stringify(restored)).toBe("restored");
    expect(await beforeLocal()).toBe(localBefore);
    expect(await readFile(join(originalLocal, "notes.md"), "utf8")).toBe("Local before.\r\n");
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
    expect(
      await createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")).read(),
    ).toMatchObject({ status: "ready", state: { uses: [] } });
    expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toMatchObject({
      status: "ready",
      bindings: [],
    });
  } finally {
    await rename(offlinePath, fixture.sourceRoot);
  }
  expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);
});

it("withholds inverse consent when an unreviewed file appears after linkage", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  const linked = await linkOneCopy(fixture, skillId);
  const local = join(fixture.projectRoot, projectSkill);
  await writeFile(join(local, "unreviewed.md"), "Keep this foreign file.\n");
  const before = await treeDigest(local);
  const restore = await previewIntent({ kind: "restore", operationId: linked.operationId });
  expect(restore.status).toBe("blocked");
  expect(await treeDigest(local)).toBe(before);
  expect(await readFile(join(local, "unreviewed.md"), "utf8")).toBe("Keep this foreign file.\n");
});

it("resumes an interrupted inverse from its durable applied action after coordinator restart", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  const local = join(fixture.projectRoot, projectSkill);
  const before = new Map([
    [`${projectSkill}/SKILL.md`, "---\nname: demo\n---\n# Local instructions before.\r\n"],
    [`${projectSkill}/notes.md`, "Local notes before.\r\n"],
  ]);
  await writeFile(join(local, "SKILL.md"), before.get(`${projectSkill}/SKILL.md`)!);
  await writeFile(join(local, "notes.md"), before.get(`${projectSkill}/notes.md`)!);
  await registerOperations(fixture);
  const linked = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "link-canonical",
      skillId,
      source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect(linked.status).toBe("ready");
  if (linked.status !== "ready") throw new Error("Expected a reviewed unbound link.");
  expect((await applyPreview(linked)).status).toBe("applied");

  const restore = await previewIntent({ kind: "restore", operationId: linked.intentId });
  expect(restore.status).toBe("ready");
  if (restore.status !== "ready") throw new Error("Expected a public-parent inverse preview.");
  const step = restore.steps[0]!;
  expect(step.plan.actions).toHaveLength(2);
  const completed = step.plan.actions[0]!;
  const content = before.get(completed.relativePath);
  expect(content).toBeDefined();
  const target = join(fixture.projectRoot, completed.relativePath);
  await writeFile(target, content!);
  const details = await lstat(target, { bigint: true });
  const journal = createSkillOperationJournal(join(fixture.userDataPath, "omni", "skill-operations"));
  const saved = await journal.read(restore.intentId);
  expect(saved.status).toBe("ready");
  if (saved.status !== "ready") throw new Error("Expected the inverse journal to be durable.");
  await journal.write({
    ...saved.record,
    status: "recovery-required",
    updatedAt: new Date().toISOString(),
    steps: saved.record.steps.map((candidate) =>
      candidate.stepId !== step.stepId
        ? candidate
        : {
            ...candidate,
            status: "recovery-required",
            actions: [
              {
                relativePath: completed.relativePath,
                kind: "write-file",
                status: "applied",
                ...(completed.afterHash ? { afterHash: completed.afterHash } : {}),
                identity: `${details.dev}:${details.ino}`,
              },
            ],
          },
    ),
  });

  await registerOperations(fixture);
  const resumed = await previewIntent({ kind: "restore", operationId: linked.intentId });
  expect(resumed.status).toBe("ready");
  if (resumed.status !== "ready") throw new Error("Expected the interrupted inverse to be resumable.");
  expect(resumed.steps[0]!.plan.actions).toHaveLength(1);
  expect(resumed.steps[0]!.plan.actions[0]!.relativePath).not.toBe(completed.relativePath);
  expect((await applyPreview(resumed)).status).toBe("restored");
  for (const [path, expected] of before) expect(await readFile(join(fixture.projectRoot, path), "utf8")).toBe(expected);
});
