import { readFile, lstat, rm, symlink, readlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedFixture, registerOperations, projectSkill, claudeSkill } from "./skill-adoption-fixture";

it("removes only the selected agent, disables the last copy and restores exact bytes after restart", async () => {
  const fixture = await seedFixture();
  let service = (await registerOperations(fixture)).skillManagement;
  const original = await readFile(join(fixture.projectRoot, projectSkill, "support/payload.bin"));
  const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
  const operate = async (intent: unknown) => {
    const preview = await service.preview(intent, { kind: "desktop" });
    expect(preview.status, JSON.stringify(preview)).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.reason);
    const result = await service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toMatch(/^(applied|restored)$/);
    return result;
  };
  const intent = { kind: "project-skill", projectId: fixture.project.id, rowId: row.id };
  const removed = await operate({ ...intent, action: "remove-agent", harnessIds: ["codex"] });
  await expect(lstat(join(fixture.projectRoot, projectSkill))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("# Demo");
  const last = await operate({ ...intent, action: "remove-agent", harnessIds: ["claude-code"] });
  const { createOperationStore } = await import("../../src/main/operation-store");
  expect(await createOperationStore(join(fixture.userDataPath, "omni/operations.json")).read()).toMatchObject({
    receipts: expect.arrayContaining([expect.objectContaining({ displayTarget: "disable · demo" })]),
  });
  service = (await registerOperations(fixture)).skillManagement;
  await operate({ kind: "restore", operationId: last.operationId });
  const installed = await operate({ ...intent, action: "install-agent", harnessIds: ["codex"] });
  expect(await readFile(join(fixture.projectRoot, projectSkill, "support/payload.bin"))).toEqual(original);
  await operate({ kind: "restore", operationId: installed.operationId });
  await operate({ kind: "restore", operationId: removed.operationId });
  expect(await readFile(join(fixture.projectRoot, projectSkill, "support/payload.bin"))).toEqual(original);
});

it("keeps the other agent's skill readable when its symlink points to the removed copy", async () => {
  const fixture = await seedFixture();
  await rm(join(fixture.projectRoot, claudeSkill), { recursive: true });
  await symlink("../../.agents/skills/demo", join(fixture.projectRoot, claudeSkill));
  const service = (await registerOperations(fixture)).skillManagement;
  const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
  const bytes = await readFile(join(fixture.projectRoot, claudeSkill, "support/payload.bin"));
  const preview = await service.preview(
    {
      kind: "project-skill",
      projectId: fixture.project.id,
      rowId: row.id,
      action: "remove-agent",
      harnessIds: ["codex"],
    },
    { kind: "desktop" },
  );
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.reason);
  const removed = await service.apply(preview.intentId, {
    kind: "desktop",
    effectFingerprint: preview.effectFingerprint,
    approvedAt: new Date().toISOString(),
  });
  expect(removed.status).toBe("applied");
  expect(await readFile(join(fixture.projectRoot, claudeSkill, "support/payload.bin"))).toEqual(bytes);
  const restore = await service.preview({ kind: "restore", operationId: removed.operationId }, { kind: "desktop" });
  if (restore.status !== "ready") throw new Error(restore.reason);
  expect(
    (
      await service.apply(restore.intentId, {
        kind: "desktop",
        effectFingerprint: restore.effectFingerprint,
        approvedAt: new Date().toISOString(),
      })
    ).status,
  ).toBe("restored");
  expect(await readlink(join(fixture.projectRoot, claudeSkill))).toBe("../../.agents/skills/demo");
});
