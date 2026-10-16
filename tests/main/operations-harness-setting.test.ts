import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationStore } from "../../src/main/operation-store";
import { createHarnessSettingOperations } from "../../src/main/operations-harness-setting";
import { createRestoreOperations } from "../../src/main/operations-restore";

const roots: string[] = [];

async function setup(): Promise<Readonly<{ homeDir: string; userDataPath: string }>> {
  const root = await mkdtemp(join(tmpdir(), "omni-harness-setting-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const userDataPath = join(root, "user-data");
  await mkdir(join(homeDir, ".claude"), { recursive: true });
  return { homeDir, userDataPath };
}

function createGitStub() {
  return {
    isGitAvailable: async () => false,
    isRepositoryRoot: async () => false,
  } as never;
}

async function settingsOf(homeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(homeDir, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("write-harness-setting operation", () => {
  it("sets cleanupPeriodDays on a missing file and preserves every other key when one already exists", async () => {
    const { homeDir, userDataPath } = await setup();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] } }, null, 2));
    const operations = createHarnessSettingOperations({ homeDir, userDataPath });

    const preview = await operations.preview({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: 14,
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan.actions).toHaveLength(1);
    expect(preview.plan.actions[0]).toMatchObject({
      kind: "write-file",
      relativePath: join(".claude", "settings.json"),
      beforeHash: expect.any(String),
    });
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    expect(applied?.receipt).toMatchObject({
      kind: "write-harness-setting",
      harnessSetting: { harness: "claude-code", key: "cleanupPeriodDays", value: 14, previousValue: null },
    });
    const updated = await settingsOf(homeDir);
    expect(updated).toEqual({ model: "opus", permissions: { allow: ["Bash"] }, cleanupPeriodDays: 14 });
  });

  it("unsets the key (deletes it) when the value is null, and is a no-op when already unset", async () => {
    const { homeDir, userDataPath } = await setup();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ model: "opus", cleanupPeriodDays: 30 }, null, 2));
    const operations = createHarnessSettingOperations({ homeDir, userDataPath });

    const preview = await operations.preview({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: null,
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    await operations.apply({ planId: preview.plan.planId });
    expect(await settingsOf(homeDir)).toEqual({ model: "opus" });

    const again = await operations.preview({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: null,
    });
    expect(again.status).toBe("ready");
    if (again.status !== "ready") return;
    expect(again.plan.actions).toEqual([]);
    expect(again.plan.notes).toContain("unchanged");
  });

  it("is a no-op preview when the requested value already matches the current one", async () => {
    const { homeDir, userDataPath } = await setup();
    await writeFile(join(homeDir, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }, null, 2));
    const operations = createHarnessSettingOperations({ homeDir, userDataPath });

    const preview = await operations.preview({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: 7,
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.plan.actions).toEqual([]);
  });

  it("blocks invalid JSON with a clear diagnostic", async () => {
    const { homeDir, userDataPath } = await setup();
    await writeFile(join(homeDir, ".claude", "settings.json"), "{ not json");
    const operations = createHarnessSettingOperations({ homeDir, userDataPath });

    const preview = await operations.preview({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: 14,
    });
    expect(preview).toMatchObject({ status: "blocked" });
    if (preview.status === "blocked") expect(preview.diagnostic).toMatch(/valid JSON/i);
  });

  it("restores the previous value through the reverse edit, and blocks when the key drifted since", async () => {
    const { homeDir, userDataPath } = await setup();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ model: "opus", cleanupPeriodDays: 7 }, null, 2));
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createHarnessSettingOperations({ homeDir, userDataPath, operationStore: store });

    const preview = await operations.preview({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: 14,
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");
    expect(await settingsOf(homeDir)).toMatchObject({ cleanupPeriodDays: 14 });

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: createGitStub(), homeDir });
    const restorePreview = await restore.preview({
      kind: "restore-import",
      operationId: applied!.receipt.operationId,
    });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    const restoreApplied = await restore.apply({ planId: restorePreview.plan.planId });
    expect(restoreApplied?.status).toBe("applied");
    expect(await settingsOf(homeDir)).toMatchObject({ model: "opus", cleanupPeriodDays: 7 });

    // Drift: apply again, then hand-edit the key before restoring — restore must refuse.
    const secondPreview = await operations.preview({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: 30,
    });
    expect(secondPreview.status).toBe("ready");
    if (secondPreview.status !== "ready") return;
    const secondApplied = await operations.apply({ planId: secondPreview.plan.planId });
    expect(secondApplied?.status).toBe("applied");
    const current = await settingsOf(homeDir);
    current.cleanupPeriodDays = 21;
    await writeFile(settingsPath, JSON.stringify(current, null, 2));
    await expect(
      restore.preview({ kind: "restore-import", operationId: secondApplied!.receipt.operationId }),
    ).resolves.toMatchObject({ status: "blocked", reason: "restore-drift" });
  });

  it("restoring an originally absent settings file removes it", async () => {
    const { homeDir, userDataPath } = await setup();
    const store = createOperationStore(join(userDataPath, "omni", "operations.json"));
    const operations = createHarnessSettingOperations({ homeDir, userDataPath, operationStore: store });

    const preview = await operations.preview({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: 14,
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    const applied = await operations.apply({ planId: preview.plan.planId });
    expect(applied?.status).toBe("applied");

    const restore = createRestoreOperations({ userDataPath, operationStore: store, git: createGitStub(), homeDir });
    const restorePreview = await restore.preview({
      kind: "restore-import",
      operationId: applied!.receipt.operationId,
    });
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") return;
    expect((await restore.apply({ planId: restorePreview.plan.planId }))?.status).toBe("applied");
    await expect(readFile(join(homeDir, ".claude/settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
