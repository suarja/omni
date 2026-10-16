import { chmod, lchmod, lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  seedFixture,
  observedSkillId,
  registerOperations,
  projectSkill,
  claudeSkill,
  sourcePackage,
  sourceSkill,
} from "./skill-adoption-fixture";
import { handlers } from "../ipc/apply-ipc-helpers";

async function operate(service: Awaited<ReturnType<typeof registerOperations>>["skillManagement"], intent: unknown) {
  const preview = await service.preview(intent, { kind: "desktop" });
  expect(preview.status, JSON.stringify(preview)).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.reason);
  const result = await service.apply(preview.intentId, {
    kind: "desktop",
    effectFingerprint: preview.effectFingerprint,
    approvedAt: new Date().toISOString(),
  });
  expect(result.status, JSON.stringify(result)).toMatch(/^(applied|restored|no-op)$/);
  return result;
}

async function managedFixture() {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  const { skillManagement: service } = await registerOperations(fixture);
  await operate(service, {
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
  });
  return { ...fixture, service, skillId };
}

async function removeManagedCodex(fixture: Awaited<ReturnType<typeof managedFixture>>): Promise<void> {
  const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
  const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
  const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
  const current = await relationships.read();
  if (current.status !== "ready") throw new Error("Fixture relationships are unavailable.");
  const use = current.state.uses.find((use) => use.location.harnessId === "codex")!;
  await relationships.updateUsesExact(current.state.revision, [
    { skillId: use.skillId, location: use.location, before: use },
  ]);
  await createBindingsStore(bindingsFilePath(fixture.userDataPath)).remove(use.bindingId);
  await rm(join(fixture.projectRoot, projectSkill), { recursive: true });
}

describe("project skills lifecycle", () => {
  it("forgets observed project-only identities on delete and restores their exact records", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const { skillManagement: service } = await registerOperations(fixture);
    const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
    const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
    const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
    const deleted = await operate(service, {
      kind: "project-skill",
      action: "delete",
      projectId: fixture.project.id,
      rowId: row.id,
    });
    expect(await relationships.read()).toMatchObject({ state: { skills: [], uses: [] } });
    await operate(service, { kind: "restore", operationId: deleted.operationId });
    expect(await relationships.read()).toMatchObject({ state: { skills: [{ skillId }], uses: [] } });
  });

  it("deletes a managed use even when that agent's project copy is already missing", async () => {
    const fixture = await managedFixture();
    const row = (await fixture.service.readProjectSkills!(fixture.project.id)).skills[0]!;
    await rm(join(fixture.projectRoot, projectSkill), { recursive: true });
    await operate(fixture.service, {
      kind: "project-skill",
      action: "delete",
      projectId: fixture.project.id,
      rowId: row.id,
    });
    expect(
      await fixture.service.readPropagationCandidates!({
        sourceId: fixture.source.id,
        packageId: sourcePackage,
        artifactPath: sourceSkill,
      }),
    ).toEqual([]);
  });
  it("deletes a marketplace skill only from its project and restores both managed uses", async () => {
    const fixture = await managedFixture();
    const row = (await fixture.service.readProjectSkills!(fixture.project.id)).skills[0]!;
    const sourceBefore = await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"));
    const deleted = await operate(fixture.service, {
      kind: "project-skill",
      action: "delete",
      projectId: fixture.project.id,
      rowId: row.id,
    });
    expect((await fixture.service.readProjectSkills!(fixture.project.id)).skills).toEqual([]);
    expect(
      await fixture.service.readPropagationCandidates!({
        sourceId: fixture.source.id,
        packageId: sourcePackage,
        artifactPath: sourceSkill,
      }),
    ).toEqual([]);
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"))).toEqual(sourceBefore);
    await operate(fixture.service, { kind: "restore", operationId: deleted.operationId });
    expect((await fixture.service.readProjectSkills!(fixture.project.id)).skills[0]).toMatchObject({
      skillId: row.skillId,
      state: "current",
      agents: { codex: { state: "installed" }, "claude-code": { state: "installed" } },
    });
  });

  it("installs a missing managed agent through assignment and forgets its created use on restore", async () => {
    const fixture = await managedFixture();
    const row = (await fixture.service.readProjectSkills!(fixture.project.id)).skills[0]!;
    const deleted = await operate(fixture.service, {
      kind: "project-skill",
      action: "delete",
      projectId: fixture.project.id,
      rowId: row.id,
    });
    await operate(fixture.service, { kind: "restore", operationId: deleted.operationId });
    await removeManagedCodex(fixture);
    const installed = await operate(fixture.service, {
      kind: "project-skill",
      action: "install-agent",
      projectId: fixture.project.id,
      rowId: row.id,
      harnessIds: ["codex"],
    });
    expect(installed.receipts?.some((receipt) => receipt.kind === "apply-plan")).toBe(true);
    expect((await fixture.service.readProjectSkills!(fixture.project.id)).skills).toHaveLength(1);
    const candidates = await fixture.service.readPropagationCandidates!({
      sourceId: fixture.source.id,
      packageId: sourcePackage,
      artifactPath: sourceSkill,
    });
    expect(candidates[0]?.locations).toHaveLength(2);
    await operate(fixture.service, { kind: "restore", operationId: installed.operationId });
    expect(
      (
        await fixture.service.readPropagationCandidates!({
          sourceId: fixture.source.id,
          packageId: sourcePackage,
          artifactPath: sourceSkill,
        })
      )[0]?.locations,
    ).toHaveLength(1);
    await expect(lstat(join(fixture.projectRoot, projectSkill))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["prepared", "applied"] as const)(
    "reports a tracking failure after managed installation and restores after restart (%s)",
    async (phase) => {
      const fixture = await managedFixture();
      await removeManagedCodex(fixture);
      const { createOperationStore } = await import("../../src/main/operation-store");
      const history = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
      const { skillManagement: service } = await registerOperations(fixture, {
        ...history,
        async append(receipt) {
          if (receipt.legacyBridge?.phase === phase) throw new Error("Tracking receipt unavailable.");
          return history.append(receipt);
        },
      });
      const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
      const preview = await service.preview(
        {
          kind: "project-skill",
          action: "install-agent",
          projectId: fixture.project.id,
          rowId: row.id,
          harnessIds: ["codex"],
        },
        { kind: "desktop" },
      );
      if (preview.status !== "ready") throw new Error(preview.reason);
      const result = await service.apply(preview.intentId, {
        kind: "desktop",
        effectFingerprint: preview.effectFingerprint,
        approvedAt: new Date().toISOString(),
      });
      const status = phase === "prepared" ? "partial" : "recovery-required";
      expect(result.status).toBe(status);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "project-skill-tracking-incomplete", projectId: fixture.project.id }),
      );
      expect(await service.readResult(result.intentId)).toMatchObject({ status });
      expect(await history.read()).toMatchObject({
        receipts: expect.arrayContaining([
          expect.objectContaining({
            operationId: result.operationId,
            status: "failed",
            skillManagement: expect.objectContaining({ status }),
          }),
        ]),
      });
      const restarted = (await registerOperations(fixture, history)).skillManagement;
      expect(
        (
          await restarted.readPropagationCandidates!({
            sourceId: fixture.source.id,
            packageId: sourcePackage,
            artifactPath: sourceSkill,
          })
        )[0]?.locations,
      ).toHaveLength(2);
      await operate(restarted, { kind: "restore", operationId: result.operationId });
      await expect(lstat(join(fixture.projectRoot, projectSkill))).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (
          await restarted.readPropagationCandidates!({
            sourceId: fixture.source.id,
            packageId: sourcePackage,
            artifactPath: sourceSkill,
          })
        )[0]?.locations,
      ).toHaveLength(1);
    },
  );
  it("parks edited managed copies exactly and excludes them from maintenance until enabled", async () => {
    const fixture = await managedFixture();
    const { service, projectRoot, project, sourceRoot } = fixture;
    await writeFile(join(projectRoot, projectSkill, "notes.md"), "Owner edit\n");
    await chmod(join(projectRoot, projectSkill, "notes.md"), 0o751);
    const row = (await service.readProjectSkills!(project.id)).skills.find((row) => row.skillId === fixture.skillId)!;
    const disabled = await operate(service, {
      kind: "project-skill",
      action: "disable",
      projectId: project.id,
      rowId: row.id,
    });
    for (const folder of [projectSkill, claudeSkill])
      await expect(lstat(join(projectRoot, folder))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.readProjectSkills!(project.id)).skills[0]?.agents.codex.state).toBe("disabled");
    const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
    await writeFile(join(sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), "---\nname: demo\n---\n# Updated\n");
    const maintenance = await service.preview({ kind: "maintain-current", source }, { kind: "desktop" });
    expect(maintenance.status).toBe("ready");
    if (maintenance.status === "ready") expect(maintenance.propagation?.targets).toEqual([]);
    expect(await service.readPropagationCandidates!(source)).toEqual([]);
    await operate(service, { kind: "project-skill", action: "enable", projectId: project.id, rowId: row.id });
    expect(await readFile(join(projectRoot, projectSkill, "notes.md"), "utf8")).toBe("Owner edit\n");
    expect((await stat(join(projectRoot, projectSkill, "notes.md"))).mode & 0o777).toBe(0o751);
    expect(await readFile(join(projectRoot, projectSkill, "support/payload.bin"))).toEqual(Buffer.from([0, 1, 255, 3]));
    expect((await service.readProjectSkills!(project.id)).skills[0]?.state).toBe("modified-here");
    expect(await service.readResult(disabled.intentId)).toMatchObject({ status: "applied" });
  });

  it("parks only a symlink without touching its target and refuses occupied enable locations", async () => {
    const fixture = await seedFixture();
    await rm(join(fixture.projectRoot, claudeSkill), { recursive: true });
    const target = "../../.agents/skills/demo";
    await symlink(target, join(fixture.projectRoot, claudeSkill));
    const { skillManagement: service } = await registerOperations(fixture);
    const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
    expect(row.agents["claude-code"]).toMatchObject({ state: "installed", symlink: true });
    const disabled = await operate(service, {
      kind: "project-skill",
      action: "disable",
      projectId: fixture.project.id,
      rowId: row.id,
      harnessIds: ["claude-code"],
    });
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).toContain("# Demo");
    await mkdir(join(fixture.projectRoot, claudeSkill));
    const blocked = await service.preview(
      { kind: "project-skill", action: "enable", projectId: fixture.project.id, rowId: row.id },
      { kind: "desktop" },
    );
    expect(blocked).toMatchObject({ status: "blocked" });
    await rm(join(fixture.projectRoot, claudeSkill), { recursive: true });
    await operate(service, { kind: "restore", operationId: disabled.operationId });
    expect(await readlink(join(fixture.projectRoot, claudeSkill))).toBe(target);
  });

  it.runIf(process.platform === "darwin")(
    "preserves a symlink's own mode while its target stays untouched",
    async () => {
      const fixture = await seedFixture();
      await rm(join(fixture.projectRoot, claudeSkill), { recursive: true });
      const link = join(fixture.projectRoot, claudeSkill);
      await symlink("../../.agents/skills/demo", link);
      await lchmod(link, 0o751);
      const targetMode = (await stat(join(fixture.projectRoot, projectSkill))).mode;
      const { skillManagement: service } = await registerOperations(fixture);
      const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
      const intent = {
        kind: "project-skill",
        projectId: fixture.project.id,
        rowId: row.id,
        harnessIds: ["claude-code"],
      };
      await operate(service, { ...intent, action: "disable" });
      await operate(service, { ...intent, action: "enable" });
      expect((await lstat(link)).mode & 0o7777).toBe(0o751);
      expect((await stat(join(fixture.projectRoot, projectSkill))).mode).toBe(targetMode);
    },
  );

  it("copies a one-sided project skill for Codex and restores install, disable, enable and delete receipts after restart", async () => {
    const fixture = await seedFixture();
    await rm(join(fixture.projectRoot, projectSkill), { recursive: true });
    let { skillManagement: service } = await registerOperations(fixture);
    const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
    expect(row.origin.kind).toBe("project-only");
    expect(row.agents.codex.state).toBe("absent");
    const installed = await operate(service, {
      kind: "project-skill",
      action: "install-agent",
      projectId: fixture.project.id,
      rowId: row.id,
      harnessIds: ["codex"],
    });
    expect(await readFile(join(fixture.projectRoot, projectSkill, "support/payload.bin"))).toEqual(
      Buffer.from([0, 1, 255, 3]),
    );
    service = (await registerOperations(fixture)).skillManagement;
    await operate(service, { kind: "restore", operationId: installed.operationId });
    await expect(lstat(join(fixture.projectRoot, projectSkill))).rejects.toMatchObject({ code: "ENOENT" });
    const disabled = await operate(service, {
      kind: "project-skill",
      action: "disable",
      projectId: fixture.project.id,
      rowId: row.id,
    });
    const enabled = await operate(service, {
      kind: "project-skill",
      action: "enable",
      projectId: fixture.project.id,
      rowId: row.id,
    });
    await operate(service, { kind: "restore", operationId: enabled.operationId });
    expect((await service.readProjectSkills!(fixture.project.id)).skills[0]?.agents["claude-code"].state).toBe(
      "disabled",
    );
    const deleted = await operate(service, {
      kind: "project-skill",
      action: "delete",
      projectId: fixture.project.id,
      rowId: row.id,
    });
    expect((await service.readProjectSkills!(fixture.project.id)).skills).toEqual([]);
    service = (await registerOperations(fixture)).skillManagement;
    await operate(service, { kind: "restore", operationId: deleted.operationId });
    expect((await service.readProjectSkills!(fixture.project.id)).skills[0]?.agents["claude-code"].state).toBe(
      "disabled",
    );
    await operate(service, { kind: "restore", operationId: disabled.operationId });
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("# Demo");
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    expect(
      await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.projectSkills)!({}, { projectId: fixture.project.id }),
    ).toMatchObject({ activeSkillCount: { codex: 0, "claude-code": 1 } });
  });
});
