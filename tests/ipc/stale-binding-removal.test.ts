import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRemovePreviewResponse } from "../../src/shared/apply-ipc";
import { treeDigest } from "../integration/skill-adoption-fixture";
import { setup, saveBindings, removePreview, removeRun, restorePreview, restoreRun } from "./apply-ipc-helpers";

describe("stale binding removal", () => {
  it("forgets only the binding and Undo restores it without changing project or source files", async () => {
    const f = await setup();
    const peer = { ...f.binding, bindingId: "peer-binding", harnessId: "codex" as const };
    await saveBindings([f.binding, peer]);
    await writeFile(join(f.projectRoot, "keep.txt"), "Owner content\n");
    const before = { project: await treeDigest(f.projectRoot), source: await treeDigest(f.sourceRoot) };
    const preview = await removePreview(f);
    expect(preview).toMatchObject({
      status: "ready",
      files: [],
      notes: [expect.stringContaining("already gone"), expect.stringContaining("Forget this use")],
    });
    expect(parseRemovePreviewResponse(preview)).toEqual(preview);
    expect(() => parseRemovePreviewResponse({ ...preview, notes: [1] })).toThrow("notes are invalid");
    expect(await f.bindings.readBindings()).toMatchObject({ bindings: [f.binding, peer] });
    const removed = await removeRun(preview.planId);
    expect(removed).toMatchObject({
      status: "applied",
      receipt: { kind: "remove-binding", actions: [], files: [], bindings: [{ before: f.binding }] },
    });
    expect(await f.bindings.readBindings()).toMatchObject({ bindings: [peer] });
    expect(await treeDigest(f.projectRoot)).toEqual(before.project);
    expect(await treeDigest(f.sourceRoot)).toEqual(before.source);
    const restore = await restorePreview(removed.receipt.operationId);
    expect(restore).toMatchObject({ status: "ready", files: [] });
    expect(await restoreRun(restore.planId)).toMatchObject({ status: "applied", receipt: { actions: [], files: [] } });
    expect(await f.bindings.readBindings()).toMatchObject({ bindings: [peer, f.binding] });
    expect(await treeDigest(f.projectRoot)).toEqual(before.project);
    expect(await treeDigest(f.sourceRoot)).toEqual(before.source);
  });

  it.each(["outside", "dangling", "unreadable"])("blocks a present %s target and keeps its binding", async (kind) => {
    const f = await setup({ commitChanges: false });
    await saveBindings([f.binding]);
    const target = join(f.projectRoot, ".claude/skills/demo");
    await mkdir(join(f.projectRoot, ".claude/skills"), { recursive: true });
    if (kind === "unreadable") {
      await mkdir(target);
      await writeFile(join(target, "SKILL.md"), "private\n");
      await chmod(join(target, "SKILL.md"), 0o000);
    } else await symlink(kind === "outside" ? f.sourceRoot : join(f.projectRoot, "gone"), target);
    try {
      expect(await removePreview(f)).toMatchObject({ status: "blocked", reason: "target-unreadable" });
      expect(await f.bindings.readBindings()).toMatchObject({ bindings: [f.binding] });
    } finally {
      if (kind === "unreadable") await chmod(join(target, "SKILL.md"), 0o644);
    }
  });

  it("blocks forgetting if the missing target becomes a dangling link after preview", async () => {
    const f = await setup({ commitChanges: false });
    await saveBindings([f.binding]);
    const preview = await removePreview(f);
    expect(preview.status).toBe("ready");
    await mkdir(join(f.projectRoot, ".claude/skills"), { recursive: true });
    await symlink("gone", join(f.projectRoot, ".claude/skills/demo"));
    expect(await removeRun(preview.planId)).toMatchObject({ status: "blocked" });
    expect(await f.bindings.readBindings()).toMatchObject({ bindings: [f.binding] });
  });

  it("does not mistake an absent child under a dangling parent link for an absent target", async () => {
    const f = await setup({ commitChanges: false });
    await saveBindings([f.binding]);
    await symlink("gone", join(f.projectRoot, ".claude"));
    expect(await removePreview(f)).toMatchObject({ status: "blocked", reason: "target-unreadable" });
    expect(await f.bindings.readBindings()).toMatchObject({ bindings: [f.binding] });
  });

  it("keeps a binding changed after the forget preview", async () => {
    const f = await setup({ commitChanges: false });
    await saveBindings([f.binding]);
    const preview = await removePreview(f);
    expect(preview.status).toBe("ready");
    const changed = { ...f.binding, boundHash: "b".repeat(64) };
    await saveBindings([changed]);
    expect(await removeRun(preview.planId)).toMatchObject({ status: "blocked", reason: "plan-changed" });
    expect(await f.bindings.readBindings()).toMatchObject({ bindings: [changed] });
  });
});
