import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveApprovalInput, resolveApproval } from "../../src/main/agent-gateway/approval";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES, type Settings } from "../../src/shared/settings-ipc";
import { parseProjectSkillIntent, parseProjectSkillsRequest } from "../../src/shared/project-skills-ipc";
import { seedFixture, registerOperations, projectSkill, claudeSkill } from "./skill-adoption-fixture";
import { createProjectSkillsAdapter } from "../../src/main/skill-management/project-skills";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";
import { createOperationStore } from "../../src/main/operation-store";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";
import { readFileSync, writeFileSync } from "node:fs";

const settings: Settings = {
  schemaVersion: 8,
  git: { commitChanges: false },
  agents: {
    approval: { personalMarketplace: "conversation", projects: "conversation" },
    guard: { warnProjectIds: [] },
  },
  ai: DEFAULT_AI_SETTINGS,
  features: DEFAULT_FEATURES,
  externalLibrary: { updates: "auto" as const },
};
async function preview(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  action: "delete" | "disable" | "enable" | "install-agent",
  harnessIds?: readonly ["codex" | "claude-code"],
) {
  const { skillManagement: service } = await registerOperations(fixture);
  const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
  const intent = {
    kind: "project-skill" as const,
    action,
    projectId: fixture.project.id,
    rowId: row.id,
    ...(harnessIds ? { harnessIds } : {}),
  };
  const preview = await service.preview(intent, { kind: "desktop" });
  expect(preview.status, JSON.stringify(preview)).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.reason);
  return {
    service,
    intent,
    preview,
    apply: () =>
      service.apply(preview.intentId, {
        kind: "desktop",
        effectFingerprint: preview.effectFingerprint,
        approvedAt: new Date().toISOString(),
      }),
  };
}

describe("project skill safety boundaries", () => {
  it("rejects traversal, extra fields, duplicate agents and a whole-skill deletion narrowed to an agent", () => {
    expect(() => parseProjectSkillsRequest({ projectId: "../owner" })).toThrow();
    expect(() => parseProjectSkillsRequest({ projectId: "project", root: "/owner" })).toThrow();
    const intent = { kind: "project-skill", projectId: "project", rowId: "skill", action: "disable" };
    expect(() => parseProjectSkillIntent({ ...intent, harnessIds: ["codex", "codex"] })).toThrow();
    expect(() => parseProjectSkillIntent({ ...intent, action: "delete", harnessIds: ["codex"] })).toThrow();
    expect(() => parseProjectSkillIntent({ ...intent, action: "install-agent" })).toThrow();
  });

  it("withholds the whole disable operation when a selected copy changes after preview", async () => {
    const fixture = await seedFixture();
    const operation = await preview(fixture, "disable");
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "After preview\n");
    const result = await operation.apply();
    expect(result.status).toBe("failed");
    expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"), "utf8")).toBe("After preview\n");
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("# Demo");
    const restored = await operation.service.preview(
      { kind: "restore", operationId: result.operationId },
      { kind: "desktop" },
    );
    expect(restored.status).toBe("blocked");
  });

  it("withholds a peer installation when its source changes after preview", async () => {
    const fixture = await seedFixture();
    await rm(join(fixture.projectRoot, projectSkill), { recursive: true });
    const operation = await preview(fixture, "install-agent", ["codex"]);
    await writeFile(join(fixture.projectRoot, claudeSkill, "notes.md"), "New peer revision\n");
    expect((await operation.apply()).status).toBe("failed");
    await expect(lstat(join(fixture.projectRoot, projectSkill))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains edits made after installing a peer when restoring its receipt", async () => {
    const fixture = await seedFixture();
    await rm(join(fixture.projectRoot, projectSkill), { recursive: true });
    const operation = await preview(fixture, "install-agent", ["codex"]);
    const installed = await operation.apply();
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Later owner edit\n");
    expect(
      await operation.service.preview({ kind: "restore", operationId: installed.operationId }, { kind: "desktop" }),
    ).toMatchObject({ status: "blocked" });
    expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"), "utf8")).toBe("Later owner edit\n");
  });

  it("rejects a recovery manifest that no longer matches the journal's reviewed evidence", async () => {
    const fixture = await seedFixture();
    const operation = await preview(fixture, "disable");
    const disabled = await operation.apply();
    const path = join(fixture.userDataPath, "omni/backups/project-skills", disabled.intentId, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as { row: { name: string } };
    manifest.row.name = "A substituted skill";
    await writeFile(path, JSON.stringify(manifest));
    expect(
      await operation.service.preview({ kind: "restore", operationId: disabled.operationId }, { kind: "desktop" }),
    ).toMatchObject({ status: "blocked" });
  });

  it("restores applied targets after a partial failure and retains edits in a target that never started", async () => {
    const fixture = await seedFixture();
    const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
    let injected = false;
    const { skillManagement: service } = registerOperationsIpcHandlers(() => undefined, fixture.registry, {
      userDataPath: fixture.userDataPath,
      onSkillProgress: (intentId) => {
        if (injected) return;
        const path = join(fixture.userDataPath, "omni/backups/project-skills", intentId, "manifest.json");
        const manifest = JSON.parse(readFileSync(path, "utf8")) as { action: string; steps: { status: string }[] };
        if (manifest.action === "disable" && manifest.steps[0]?.status === "applied") {
          injected = true;
          writeFileSync(join(fixture.projectRoot, projectSkill, "notes.md"), "Concurrent owner edit\n");
        }
      },
    });
    await service.initialize();
    const row = (await service.readProjectSkills!(fixture.project.id)).skills[0]!;
    const preview = await service.preview(
      { kind: "project-skill", action: "disable", projectId: fixture.project.id, rowId: row.id },
      { kind: "desktop" },
    );
    if (preview.status !== "ready") throw new Error(preview.reason);
    const result = await service.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("recovery-required");
    const restore = await service.preview({ kind: "restore", operationId: result.operationId }, { kind: "desktop" });
    expect(restore.status, JSON.stringify(restore)).toBe("ready");
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
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("# Demo");
    expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"), "utf8")).toBe("Concurrent owner edit\n");
  });

  it("never traverses a redirected harness directory", async () => {
    const fixture = await seedFixture();
    const operation = await preview(fixture, "disable", ["claude-code"]);
    await rm(join(fixture.projectRoot, ".claude"), { recursive: true });
    await mkdir(join(fixture.sourceRoot, "redirect/skills/demo"), { recursive: true });
    await writeFile(join(fixture.sourceRoot, "redirect/skills/demo/SKILL.md"), "Untouched target\n");
    await symlink(join(fixture.sourceRoot, "redirect"), join(fixture.projectRoot, ".claude"));
    const result = await operation.apply();
    expect(result.status).toBe("failed");
    expect(await readFile(join(fixture.sourceRoot, "redirect/skills/demo/SKILL.md"), "utf8")).toBe(
      "Untouched target\n",
    );
  });

  it("expires project-only deletion backups at 30 days and purges their bytes with an injected clock", async () => {
    const fixture = await seedFixture();
    const operation = await preview(fixture, "delete");
    const deleted = await operation.apply();
    expect(deleted.status).toBe("applied");
    const backup = join(fixture.userDataPath, "omni/backups/project-skills", deleted.intentId);
    const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")) as { expiresAt: number };
    let now = manifest.expiresAt - 1;
    const adapter = createProjectSkillsAdapter({
      userDataPath: fixture.userDataPath,
      registry: fixture.registry,
      bindings: createBindingsStore(bindingsFilePath(fixture.userDataPath)),
      relationships: createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")),
      bases: createSkillBaseStore(fixture.userDataPath),
      operationStore: createOperationStore(join(fixture.userDataPath, "omni/operations.json")),
      journal: createSkillOperationJournal(join(fixture.userDataPath, "omni/skill-operations")),
      now: () => now,
    });
    await adapter.purgeExpired();
    expect(await readdir(backup)).toContain("manifest.json");
    now += 1;
    expect(await adapter.previewRestore(deleted.operationId, "11111111-1111-4111-8111-111111111111")).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("expired"),
    });
    await adapter.purgeExpired();
    await expect(lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await operation.service.readResult(deleted.intentId)).toMatchObject({ status: "applied" });
  });

  it("uses conversation approval for disabling and requires deletes-files approval for deleting a disabled project-only skill", async () => {
    const fixture = await seedFixture();
    const operation = await preview(fixture, "disable");
    const effects = deriveApprovalInput(operation.intent, operation.preview);
    expect(await resolveApproval({ ...effects, registry: fixture.registry, settings })).toEqual({
      mode: "conversation",
    });
    expect(
      await resolveApproval({
        ...effects,
        registry: fixture.registry,
        settings: {
          ...settings,
          agents: { ...settings.agents, approval: { ...settings.agents.approval, projects: "omni" } },
        },
      }),
    ).toMatchObject({ mode: "omni", reason: { code: "projects-setting" } });
    expect((await operation.apply()).status).toBe("applied");
    const deletion = await preview(fixture, "delete");
    expect(
      await resolveApproval({
        ...deriveApprovalInput(deletion.intent, deletion.preview),
        registry: fixture.registry,
        settings,
      }),
    ).toMatchObject({ mode: "omni", reason: { code: "deletes-files" } });
  });

  it("recreates an in-project peer link with a target valid from the other agent's folder", async () => {
    const fixture = await seedFixture();
    await rm(join(fixture.projectRoot, projectSkill), { recursive: true });
    await rm(join(fixture.projectRoot, claudeSkill), { recursive: true });
    await mkdir(join(fixture.projectRoot, "skill-sources/demo"), { recursive: true });
    await writeFile(
      join(fixture.projectRoot, "skill-sources/demo/SKILL.md"),
      "---\nname: demo\ndescription: Linked project skill.\n---\n",
    );
    await symlink("../../skill-sources/demo", join(fixture.projectRoot, claudeSkill));
    const operation = await preview(fixture, "install-agent", ["codex"]);
    expect((await operation.apply()).status).toBe("applied");
    expect((await lstat(join(fixture.projectRoot, projectSkill))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).toContain(
      "Linked project skill.",
    );
  });
});
