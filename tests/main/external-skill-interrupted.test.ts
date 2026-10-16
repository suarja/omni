import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { externalOperationFixture } from "../helpers/external-operations-fixture";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused" },
  dialog: {},
  ipcMain: { handle: vi.fn() },
}));

it("recovers written external files after a restart interrupted before receipts were saved", async () => {
  const f = await externalOperationFixture(),
    before = await readFile(join(f.projectA, "skills-lock.json"), "utf8");
  const result = await f.apply(
    await f.preview({
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: "skills/unused",
      skillName: "unused",
      targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
      conflict: "refuse",
    }),
  );
  const journal = createSkillOperationJournal(join(f.data, "omni/skill-operations"));
  const loaded = await journal.read(result.operationId);
  if (loaded.status !== "ready") throw new Error("Journal missing.");
  await journal.write({
    ...loaded.record,
    result: undefined,
    status: "applying",
    steps: loaded.record.steps.map((step) => ({ stepId: step.stepId, status: "applying" })),
  });
  await writeFile(join(f.data, "omni/operations.json"), JSON.stringify({ schemaVersion: 1, receipts: [] }));
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const service = registerOperationsIpcHandlers(() => undefined, f.registry, {
    userDataPath: f.data,
    homeDir: f.home,
    externalLibrary: f.library,
  }).skillManagement;
  await service.initialize();
  expect(await service.listRecoveries()).toHaveLength(1);
  const p = await service.preview({ kind: "restore", operationId: result.operationId }, { kind: "desktop" });
  expect(p.status, JSON.stringify(p)).toBe("ready");
  if (p.status !== "ready") throw new Error("Recovery missing.");
  expect(
    (
      await service.apply(p.intentId, {
        kind: "desktop",
        effectFingerprint: p.effectFingerprint,
        approvedAt: new Date().toISOString(),
      })
    ).status,
  ).toBe("restored");
  expect(await readFile(join(f.projectA, "skills-lock.json"), "utf8")).toBe(before);
  await expect(readFile(join(f.projectA, ".agents/skills/unused/SKILL.md"))).rejects.toThrow();
  expect(await service.listRecoveries()).toEqual([]);
});
