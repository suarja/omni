import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedFixture, registerOperations, claudeSkill, projectSkill } from "./skill-adoption-fixture";
import type { SkillManagementService } from "../../src/application/skill-management";

async function operate(service: SkillManagementService, intent: unknown) {
  const preview = await service.preview(intent, { kind: "desktop" });
  if (preview.status !== "ready") throw new Error(preview.reason);
  return service.apply(preview.intentId, {
    kind: "desktop",
    effectFingerprint: preview.effectFingerprint,
    approvedAt: new Date().toISOString(),
  });
}

async function parkedFixture() {
  const fixture = await seedFixture();
  const { skillManagement: service } = await registerOperations(fixture);
  const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
  const intent = { kind: "project-skill", projectId: fixture.project.id, rowId: row.id };
  const disabled = await operate(service, { ...intent, action: "disable" });
  expect(disabled.status).toBe("applied");
  const parkedRoot = join(fixture.userDataPath, "omni/parked");
  const directories = (await readdir(parkedRoot)).filter((name) => name !== "index.json");
  expect(directories).toHaveLength(2);
  return { ...fixture, service, intent, disabled, parkedRoot, directories };
}

describe("project skill parking cleanup", () => {
  it.each(["enable", "delete"] as const)(
    "removes consumed parking directories after the %s receipt is saved and still restores",
    async (action) => {
      const fixture = await parkedFixture();
      const { createOperationStore } = await import("../../src/main/operation-store");
      const history = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
      let checkedReceiptOrder = false;
      const { skillManagement: service } = await registerOperations(fixture, {
        ...history,
        async append(receipt) {
          if (receipt.kind === "skill-management" && receipt.displayTarget.startsWith(`${action} ·`)) {
            for (const directory of fixture.directories)
              expect((await lstat(join(fixture.parkedRoot, directory))).isDirectory()).toBe(true);
            checkedReceiptOrder = true;
          }
          return history.append(receipt);
        },
      });
      const consumed = await operate(service, { ...fixture.intent, action });
      expect(consumed.status).toBe("applied");
      expect(checkedReceiptOrder).toBe(true);
      expect(await readdir(fixture.parkedRoot)).toEqual(["index.json"]);
      expect(JSON.parse(await readFile(join(fixture.parkedRoot, "index.json"), "utf8"))).toEqual([]);
      expect((await operate(service, { kind: "restore", operationId: consumed.operationId })).status).toBe("restored");
      expect((await service.readProjectSkills!(fixture.project.id)).skills[0]?.agents.codex.state).toBe("disabled");
      expect((await operate(service, { kind: "restore", operationId: fixture.disabled.operationId })).status).toBe(
        "restored",
      );
      expect(await readdir(fixture.parkedRoot)).toEqual(["index.json"]);
      for (const path of [claudeSkill, projectSkill])
        expect(await readFile(join(fixture.projectRoot, path, "SKILL.md"), "utf8")).toContain("# Demo");
    },
  );

  it("sweeps an unreferenced orphan at startup while retaining indexed parked copies", async () => {
    const fixture = await parkedFixture();
    const orphan = join(fixture.parkedRoot, randomUUID());
    await mkdir(join(orphan, "content"), { recursive: true });
    await writeFile(join(orphan, "content/notes.md"), "Orphaned bytes\n");
    await registerOperations(fixture);
    await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of fixture.directories)
      expect(await readFile(join(fixture.parkedRoot, directory, "content/SKILL.md"), "utf8")).toContain("# Demo");
  });

  it("keeps an unindexed copy referenced by a restorable receipt until its restoration consumes it", async () => {
    const fixture = await parkedFixture();
    await writeFile(join(fixture.parkedRoot, "index.json"), "[]\n");
    const { skillManagement: service } = await registerOperations(fixture);
    for (const directory of fixture.directories)
      expect(await readFile(join(fixture.parkedRoot, directory, "content/SKILL.md"), "utf8")).toContain("# Demo");
    expect((await operate(service, { kind: "restore", operationId: fixture.disabled.operationId })).status).toBe(
      "restored",
    );
    expect(await readdir(fixture.parkedRoot)).toEqual(["index.json"]);
  });

  it("retains consumed directories when receipt persistence fails, including at the next startup", async () => {
    const fixture = await parkedFixture();
    const { createOperationStore } = await import("../../src/main/operation-store");
    const history = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
    const { skillManagement: service } = await registerOperations(fixture, {
      ...history,
      async append(receipt) {
        if (receipt.displayTarget.startsWith("enable ·")) throw new Error("Receipt persistence interrupted.");
        return history.append(receipt);
      },
    });
    await expect(operate(service, { ...fixture.intent, action: "enable" })).rejects.toThrow(/interrupted/);
    await registerOperations(fixture, history);
    for (const directory of fixture.directories)
      expect((await lstat(join(fixture.parkedRoot, directory))).isDirectory()).toBe(true);
  });

  it("releases an orphan once its referencing receipt is marked restored", async () => {
    const fixture = await parkedFixture();
    await writeFile(join(fixture.parkedRoot, "index.json"), "[]\n");
    const { createOperationStore } = await import("../../src/main/operation-store");
    const history = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
    await history.markRestored(fixture.disabled.operationId);
    await registerOperations(fixture, history);
    expect(await readdir(fixture.parkedRoot)).toEqual(["index.json"]);
  });
});
