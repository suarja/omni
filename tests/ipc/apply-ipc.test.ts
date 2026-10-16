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
  applyInitial,
  applyPreview,
  applyRun,
  expectNoAbsolutePaths,
  projectHash,
  removePreview,
  removeRun,
  restorePreview,
  restoreRun,
  setup,
  hash,
  handlers,
  run,
  saveBindings,
  type Binding,
} from "./apply-ipc-helpers";

// Real git repositories on temp roots: generous timeout so parallel workers never flake.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

describe("apply IPC contracts", () => {
  it("summarizes more than three units by count", () => {
    expect(assignmentCommitMessage("Add", ["one", "two", "three", "four", "five"], ["Claude Code", "Codex"])).toBe(
      "Add 5 skills for Claude Code and Codex",
    );
  });

  it("parses preview and explicit conflict resolutions", () => {
    expect(
      parseApplyPreviewRequest({
        projectId: "project",
        grantHandle: "project-grant",
        sourceGrantHandle: "source-grant",
      }),
    ).toEqual({ projectId: "project", grantHandle: "project-grant", sourceGrantHandle: "source-grant" });
    expect(
      parseApplyRunRequest({ planId: "plan", resolutions: [{ actionId: "action", choice: "take-marketplace" }] }),
    ).toEqual({ planId: "plan", resolutions: [{ actionId: "action", choice: "take-marketplace" }] });
  });

  it("requires explicit selected binding ids to be non-empty and unique", () => {
    const request = { projectId: "project", grantHandle: "project-grant", sourceGrantHandle: "source-grant" };
    expect(() => parseApplyPreviewRequest({ ...request, bindingIds: [] })).toThrow("non-empty");
    expect(() => parseApplyPreviewRequest({ ...request, bindingIds: ["same", "same"] })).toThrow("unique");
    expect(parseApplyPreviewRequest({ ...request, bindingIds: ["one"] })).toMatchObject({ bindingIds: ["one"] });
  });

  it("applies only selected bindings and leaves unrelated stale assignments untouched", async () => {
    const fixture = await setup();
    const stale = { ...fixture.binding, bindingId: "stale-binding", packageId: "missing-package" };
    await saveBindings([fixture.binding, stale]);

    const preview = await applyPreview(fixture, [fixture.binding.bindingId]);

    expect(preview.status).toBe("ready");
    expect(preview.actions).toHaveLength(1);
    expect(preview.actions[0]).toMatchObject({ bindingId: fixture.binding.bindingId });
    const applied = await applyRun(preview.planId);
    expect(applied.status).toBe("applied");
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
    const bindingState = (await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})) as { bindings: readonly Binding[] };
    expect(bindingState.bindings.map((binding) => binding.bindingId)).toContain(stale.bindingId);
    await expect(applyPreview(fixture, ["missing-binding"])).resolves.toMatchObject({
      status: "blocked",
      reason: "binding-unavailable",
    });
    const foreign = { ...fixture.binding, bindingId: "foreign-binding", projectId: "other-project" };
    const bindingStoreModule = await import("../../src/main/bindings-store");
    await bindingStoreModule
      .createBindingsStore(bindingStoreModule.bindingsFilePath(fixture.userDataPath))
      .save([foreign]);
    await expect(applyPreview(fixture, [fixture.binding.bindingId, foreign.bindingId])).resolves.toMatchObject({
      status: "blocked",
      reason: "binding-project-mismatch",
    });
  });

  it("adds files with hashes and one commit containing exactly the target paths", async () => {
    const fixture = await setup();
    const result = await applyInitial(fixture, [
      fixture.binding,
      { ...fixture.binding, bindingId: "codex-binding", harnessId: "codex" },
    ]);
    expect(result.status).toBe("applied");
    expect(result.receipt.files).toEqual(
      expect.arrayContaining([
        { relativePath: ".claude/skills/demo/SKILL.md", contentHash: hash("v1\n") },
        { relativePath: ".claude/skills/demo/notes.md", contentHash: hash("notes\n") },
        { relativePath: ".agents/skills/demo/SKILL.md", contentHash: hash("v1\n") },
        { relativePath: ".agents/skills/demo/notes.md", contentHash: hash("notes\n") },
      ]),
    );
    expect(
      (await run("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: fixture.projectRoot })).stdout
        .trim()
        .split("\n")
        .sort(),
    ).toEqual([
      ".agents/skills/demo/SKILL.md",
      ".agents/skills/demo/notes.md",
      ".claude/skills/demo/SKILL.md",
      ".claude/skills/demo/notes.md",
    ]);
    expect((await run("git", ["status", "--short"], { cwd: fixture.projectRoot })).stdout).toBe("");
  });

  it("applies a single-file skill provenance path as a folder and restores that folder", async () => {
    const fixture = await setup({ singleFile: true });
    const binding = { ...fixture.binding, artifactPath: "skills/demo/SKILL.md" };
    const result = await applyInitial(fixture, [binding]);

    expect(result.status).toBe("applied");
    await expect(stat(join(fixture.projectRoot, ".claude/skills/demo"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v1\n");
    await expect(applyPreview(fixture)).resolves.toMatchObject({
      actions: [expect.objectContaining({ state: "current", relativePath: ".claude/skills/demo" })],
    });

    const removed = await removeRun((await removePreview(fixture)).planId);
    expect(removed.status).toBe("applied");
    await expect(stat(join(fixture.projectRoot, ".claude/skills/demo"))).rejects.toThrow();
  });

  it("names every changed unit in apply and restore commit messages", async () => {
    const fixture = await setup();
    for (const id of ["unslop", "architect"]) {
      await mkdir(join(fixture.sourceRoot, "packages/tools/skills", id), { recursive: true });
      await writeFile(join(fixture.sourceRoot, "packages/tools/skills", id, "SKILL.md"), `${id}\n`, "utf8");
    }
    const bindings = [
      { ...fixture.binding, bindingId: "unslop-binding", artifactPath: "skills/unslop" },
      {
        ...fixture.binding,
        bindingId: "unslop-codex-binding",
        artifactPath: "skills/unslop",
        harnessId: "codex" as const,
      },
      { ...fixture.binding, bindingId: "architect-binding", artifactPath: "skills/architect" },
      {
        ...fixture.binding,
        bindingId: "architect-codex-binding",
        artifactPath: "skills/architect",
        harnessId: "codex" as const,
      },
    ];
    const applied = await applyInitial(fixture, bindings);

    expect((await run("git", ["log", "-1", "--pretty=%s"], { cwd: fixture.projectRoot })).stdout.trim()).toBe(
      "Add unslop, architect for Claude Code and Codex",
    );
    expect(applied.receipt).toMatchObject({
      displayTarget: expect.not.stringMatching(/unslop|architect/),
      units: ["unslop", "architect"],
    });

    const restoredPreview = await restorePreview(applied.receipt.operationId);
    expect((await restoreRun(restoredPreview.planId)).status).toBe("applied");
    expect((await run("git", ["log", "-1", "--pretty=%s"], { cwd: fixture.projectRoot })).stdout.trim()).toBe(
      "Restore unslop, architect for Claude Code and Codex",
    );
  });

  it("updates after the marketplace changes with a backup and previousHash", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v2\n", "utf8");
    const preview = await applyPreview(fixture);
    expect(preview.actions[0]).toMatchObject({ state: "update" });
    const result = await applyRun(preview.planId);
    expect(result.receipt.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: ".claude/skills/demo/SKILL.md", previousHash: hash("v1\n") }),
      ]),
    );
    expect(
      await readFile(
        join(
          fixture.userDataPath,
          "omni/backups",
          result.receipt.operationId,
          fixture.project.id,
          ".claude/skills/demo/SKILL.md",
        ),
        "utf8",
      ),
    ).toBe("v1\n");
  });

  it("previews a conflict with needsResolution and a unified diff", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "mine\n", "utf8");
    const preview = await applyPreview(fixture);
    expect(preview.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "conflict",
          needsResolution: true,
          diff: expect.objectContaining({ kind: "unified", text: expect.stringContaining("mine") }),
        }),
      ]),
    );
  });

  it("keeps mine without writing, records ownedHash, and later bindings preview reports current", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v2\n", "utf8");
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "mine\n", "utf8");
    const conflict = await applyPreview(fixture);
    const action = conflict.actions.find((candidate: any) => candidate.state === "conflict");
    const result = await applyRun(conflict.planId, [{ actionId: action.actionId, choice: "keep-mine" }]);
    expect(result.receipt.files).toEqual([]);
    const bindings = await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {});
    const owned = await hashGrantedPath(fixture.projectGrant, ".claude/skills/demo");
    if (owned.status !== "hashed") throw new Error("Owned target hash fixture could not be calculated.");
    const bindingList = (await handlers.get(BINDINGS_IPC_CHANNELS.list)!({}, {})) as { bindings: readonly Binding[] };
    expect(bindingList.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bindingId: fixture.binding.bindingId, ownedHash: owned.contentHash }),
      ]),
    );
    const later = (await handlers.get(BINDINGS_IPC_CHANNELS.preview)!(
      {},
      {
        source: fixture.source,
        packageId: fixture.binding.packageId,
        artifactPath: fixture.binding.artifactPath,
        projects: [
          {
            projectId: fixture.project.id,
            grantHandle: fixture.project.grantHandle,
            harnessIds: [fixture.binding.harnessId],
          },
        ],
      },
    )) as { plans: readonly { actions: readonly { state: string }[] }[] };
    expect(later.plans[0].actions[0].state).toBe("current");
  });

  it("takes the marketplace version and backs up the conflicting file", async () => {
    const fixture = await setup();
    await applyInitial(fixture);
    await writeFile(join(fixture.sourceRoot, "packages/tools/skills/demo/SKILL.md"), "v2\n", "utf8");
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "mine\n", "utf8");
    const conflict = await applyPreview(fixture);
    const action = conflict.actions.find((candidate: any) => candidate.state === "conflict");
    const result = await applyRun(conflict.planId, [{ actionId: action.actionId, choice: "take-marketplace" }]);
    expect(await readFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("v2\n");
    expect(
      await readFile(
        join(
          fixture.userDataPath,
          "omni/backups",
          result.receipt.operationId,
          fixture.project.id,
          ".claude/skills/demo/SKILL.md",
        ),
        "utf8",
      ),
    ).toBe("mine\n");
  });

  it("writes a symlinked Claude and Codex projection once and reports linked", async () => {
    const fixture = await setup();
    await mkdir(join(fixture.projectRoot, ".agents/skills"), { recursive: true });
    await mkdir(join(fixture.projectRoot, ".claude/skills/demo"), { recursive: true });
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "v0\n", "utf8");
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/notes.md"), "old\n", "utf8");
    await symlink(join(fixture.projectRoot, ".claude/skills/demo"), join(fixture.projectRoot, ".agents/skills/demo"));
    const existing = await hashGrantedPath(fixture.projectGrant, ".claude/skills/demo");
    if (existing.status !== "hashed") throw new Error("Existing symlink target hash fixture could not be calculated.");
    await saveBindings([
      { ...fixture.binding, ownedHash: existing.contentHash },
      { ...fixture.binding, bindingId: "codex-binding", harnessId: "codex", ownedHash: existing.contentHash },
    ]);
    const initialPreview = await applyPreview(fixture);
    const result = await applyRun(initialPreview.planId);
    expect(result).toMatchObject({ status: "applied" });
    expect(result.receipt.files.map((file: any) => file.relativePath).sort()).toEqual([
      ".claude/skills/demo/SKILL.md",
      ".claude/skills/demo/notes.md",
    ]);
    const preview = await applyPreview(fixture);
    expect(preview.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ harnessId: "codex", state: "linked" })]),
    );
    expect(await readlink(join(fixture.projectRoot, ".agents/skills/demo"))).toBe(
      join(fixture.projectRoot, ".claude/skills/demo"),
    );
  });

  it("rolls back a failed write to a byte-identical project directory", async () => {
    let writes = 0;
    const fileWriter: FileWriter = async (path, content, options) => {
      writes += 1;
      if (writes === 2) throw new Error("injected write failure");
      await writeFile(path, content, options);
    };
    const fixture = await setup({ fileWriter });
    const before = await projectHash(fixture);
    const result = await applyInitial(fixture);
    expect(result.status).toBe("failed");
    expect(await projectHash(fixture)).toBe(before);
  });

  it("refuses a plan when a target changes between preview and run, ignores unrelated files", async () => {
    const fixture = await setup();
    await saveBindings([fixture.binding]);
    const preview = await applyPreview(fixture);
    // An unrelated change must not block: only the targets are part of the plan id.
    await mkdir(join(fixture.projectRoot, "unrelated"));
    await writeFile(join(fixture.projectRoot, "unrelated/file.txt"), "changed\n", "utf8");
    // The target itself appearing after the preview changes the plan.
    await mkdir(join(fixture.projectRoot, ".claude/skills/demo"), { recursive: true });
    await writeFile(join(fixture.projectRoot, ".claude/skills/demo/SKILL.md"), "someone else\n", "utf8");
    await expect(applyRun(preview.planId)).resolves.toMatchObject({ status: "blocked", reason: "plan-changed" });
  });
});
