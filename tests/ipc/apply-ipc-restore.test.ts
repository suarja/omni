import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileWriter } from "../../src/main/operation-files";
import type { RegistryGrant } from "../../src/main/registry-ipc";
import { assignmentCommitMessage } from "../../src/main/apply-engine";
import { hashGrantedPath } from "../../src/main/granted-hashing";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import { APPLY_IPC_CHANNELS, parseApplyPreviewRequest, parseApplyRunRequest } from "../../src/shared/apply-ipc";
import { BINDINGS_IPC_CHANNELS } from "../../src/shared/bindings-ipc";
import {
  applyPreview,
  applyRun,
  expectNoAbsolutePaths,
  removePreview,
  removeRun,
  restorePreview,
  restoreRun,
  setup,
  applyInitial,
  saveBindings,
  run,
  hash,
  handlers,
  type Binding,
} from "./apply-ipc-helpers";

describe("apply IPC restore contracts", () => {
  // Real git repositories on temp roots: generous timeout so parallel workers never flake.
  vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

  it("removes an untouched binding, commits the deletion, and records the receipt", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    const preview = await removePreview(fixture);
    expect(preview.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: ".claude/skills/demo/SKILL.md",
          modified: false,
          contentHash: hash("v1\n"),
        }),
        expect.objectContaining({
          relativePath: ".claude/skills/demo/notes.md",
          modified: false,
          contentHash: hash("notes\n"),
        }),
      ]),
    );
    const result = await removeRun(preview.planId);
    expect(result.status).toBe("applied");
    expect(result.receipt.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: ".claude/skills/demo/SKILL.md",
          contentHash: hash("v1\n"),
          modified: false,
        }),
      ]),
    );
    expect(result.receipt).toMatchObject({ displayTarget: expect.not.stringMatching(/^demo$/), units: ["demo"] });
    await expect(readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"))).rejects.toThrow();
    expect((await run("git", ["log", "-1", "--pretty=%s"], { cwd: fixture.projectRoot })).stdout.trim()).toBe(
      "Remove demo for Claude Code",
    );
    const bindingList = (await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})) as { bindings: readonly Binding[] };
    expect(bindingList.bindings).toEqual([]);
  });

  it("blocks removal when a managed target file is locally modified", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    const bindingsBefore = await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {});
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "mine\n", "utf8");
    const preview = await removePreview(fixture);
    expect(preview.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: ".claude/skills/demo/SKILL.md",
          modified: true,
          diff: expect.objectContaining({ text: expect.stringContaining("mine") }),
        }),
      ]),
    );
    const operationsPath = join(fixture.userDataPath, "omni/operations.json");
    const operationsBefore = await readFile(operationsPath, "utf8");
    const result = await removeRun(preview.planId);
    expect(result).toMatchObject({
      status: "blocked",
      reason: "target-modified",
      diagnostic: expect.stringContaining(".claude/skills/demo/SKILL.md"),
    });
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("mine\n");
    expect(await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})).toEqual(bindingsBefore);
    expect(await readFile(operationsPath, "utf8")).toBe(operationsBefore);
  });

  it("blocks removal when a managed target file changes after preview", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    const preview = await removePreview(fixture);
    const notesPath = join(fixture.projectRoot, ".claude/skills/demo/notes.md");
    const localEdit = "edited after preview\n";
    await writeFile(notesPath, localEdit, "utf8");
    const operationsPath = join(fixture.userDataPath, "omni/operations.json");
    const operationsBefore = await readFile(operationsPath, "utf8");
    const bindingsBefore = await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {});

    const result = await removeRun(preview.planId);

    expect(result).toMatchObject({
      status: "blocked",
      reason: "target-modified",
      diagnostic: expect.stringContaining(".claude/skills/demo/notes.md"),
    });
    expect(await readFile(notesPath, "utf8")).toBe(localEdit);
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
    expect(await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})).toEqual(bindingsBefore);
    expect(await readFile(operationsPath, "utf8")).toBe(operationsBefore);
  });

  it("restores an apply receipt on the happy path", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v2\n", "utf8");
    const update = await applyRun((await applyPreview(fixture)).planId);
    const preview = await restorePreview(update.receipt.operationId);
    expect(preview.status).toBe("ready");
    expect((await restoreRun(preview.planId)).status).toBe("applied");
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
  });

  it("blocks a restore when an owned target changes after preview without mutating the project", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v2\n", "utf8");
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/notes.md"), "notes v2\n", "utf8");
    const update = await applyRun((await applyPreview(fixture)).planId);
    const preview = await restorePreview(update.receipt.operationId);
    expect(preview.status).toBe("ready");
    expect(preview.files).toEqual([
      { relativePath: ".claude/skills/demo/notes.md", action: "restore" },
      { relativePath: ".claude/skills/demo/SKILL.md", action: "restore" },
    ]);

    const skillPath = join(fixture.projectRoot, ".claude/skills/demo/SKILL.md");
    const notesPath = join(fixture.projectRoot, ".claude/skills/demo/notes.md");
    const localEdit = "local edit after restore preview\n";
    const notesBeforeRun = await readFile(notesPath, "utf8");
    await writeFile(skillPath, localEdit, "utf8");
    const operationsPath = join(fixture.userDataPath, "omni/operations.json");
    const operationsBeforeRun = await readFile(operationsPath, "utf8");
    const bindingsBeforeRun = await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {});

    await expect(restoreRun(preview.planId)).resolves.toMatchObject({
      status: "blocked",
      reason: "restore-drift",
    });

    expect(await readFile(skillPath, "utf8")).toBe(localEdit);
    expect(await readFile(notesPath, "utf8")).toBe(notesBeforeRun);
    expect(await readFile(operationsPath, "utf8")).toBe(operationsBeforeRun);
    expect(await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})).toEqual(bindingsBeforeRun);
  });

  it("blocks restoring an apply receipt after drift", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v2\n", "utf8");
    const nextUpdate = await applyRun((await applyPreview(fixture)).planId);
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "drift\n", "utf8");
    await expect(restorePreview(nextUpdate.receipt.operationId)).resolves.toMatchObject({
      status: "blocked",
      reason: "restore-drift",
    });
  });

  it("restores a remove receipt and re-creates its binding", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    const removed = await removeRun((await removePreview(fixture)).planId);
    const preview = await restorePreview(removed.receipt.operationId);
    expect(preview.files).toEqual(
      expect.arrayContaining([{ relativePath: ".claude/skills/demo/SKILL.md", action: "restore" }]),
    );
    expect((await restoreRun(preview.planId)).status).toBe("applied");
    expect((await run("git", ["log", "-1", "--pretty=%s"], { cwd: fixture.projectRoot })).stdout.trim()).toBe(
      "Restore demo for Claude Code",
    );
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
    const bindingList = (await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})) as { bindings: readonly Binding[] };
    expect(bindingList.bindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ bindingId: fixture.binding.bindingId })]),
    );
  });

  it("blocks restoring a remove receipt after a target path is recreated", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    const removed = await removeRun((await removePreview(fixture)).planId);
    await mkdir(join(fixture.projectRoot, ".claude/skills/demo"), { recursive: true });
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "drift\n", "utf8");
    await expect(restorePreview(removed.receipt.operationId)).resolves.toMatchObject({
      status: "blocked",
      reason: "restore-drift",
    });
  });

  it("writes files without a commit when commitChanges is false", async () => {
    const fixture = await setup({ commitChanges: false });
    const preview = await applyPreview(fixture);
    expect(preview.git.mode).toBe("disabled");
    const result = await applyInitial(fixture);
    expect(result.receipt.git.mode).toBe("disabled");
    await expect(run("git", ["rev-parse", "--verify", "HEAD"], { cwd: fixture.projectRoot })).rejects.toThrow();
    expect(
      (await run("git", ["status", "--short", "--untracked-files=all"], { cwd: fixture.projectRoot })).stdout,
    ).toContain(".claude/skills/demo/SKILL.md");
  });

  it("writes in a non-repository with git.mode not-a-repository and no error", async () => {
    const fixture = await setup({ repository: false });
    const preview = await applyPreview(fixture);
    expect(preview.git.mode).toBe("not-a-repository");
    const result = await applyInitial(fixture);
    expect(result.status).toBe("applied");
    expect(result.receipt.git.mode).toBe("not-a-repository");
  });

  it("keeps every IPC response free of absolute paths", async () => {
    const fixture = await setup();
    await saveBindings([fixture.binding]);
    const preview = await applyPreview(fixture);
    expectNoAbsolutePaths(preview, fixture);
    const applied = await applyRun(preview.planId);
    expectNoAbsolutePaths(applied, fixture);
    const removedPreview = await removePreview(fixture);
    expectNoAbsolutePaths(removedPreview, fixture);
    const removed = await removeRun(removedPreview.planId);
    expectNoAbsolutePaths(removed, fixture);
    const restore = await restorePreview(removed.receipt.operationId);
    expectNoAbsolutePaths(restore, fixture);
    const restored = await restoreRun(restore.planId);
    expectNoAbsolutePaths(restored, fixture);
  });
});
