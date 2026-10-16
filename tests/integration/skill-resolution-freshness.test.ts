import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { managedFixture, previewIntent, applyPreview, resolutionIntent } from "./skill-resolution-fixture";
import { projectSkill, sourcePackage, sourceSkill, treeDigest, registerOperations } from "./skill-adoption-fixture";
import { handlers } from "../ipc/apply-ipc-helpers";
import { SKILL_MANAGEMENT_IPC_CHANNELS as channels } from "../../src/shared/skill-management-ipc";

describe("reviewed managed resolution freshness", () => {
  it.each(["source", "local", "binding"] as const)("withholds stale %s consent without file writes", async (change) => {
    const fixture = await managedFixture();
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Local note.\n");
    const preview = await previewIntent(resolutionIntent(fixture, "use-canonical"));
    expect(preview.status).toBe("ready");
    if (change === "source")
      await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "notes.md"), "New source.\n");
    else if (change === "local")
      await writeFile(join(fixture.projectRoot, projectSkill, "new-local.md"), "New work.\n");
    else {
      const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
      const store = createBindingsStore(bindingsFilePath(fixture.userDataPath));
      const state = await store.read();
      if (state.status !== "ready") throw new Error("Bindings unavailable.");
      const binding = state.bindings.find((item) => item.harnessId === "codex")!;
      expect(
        (
          await store.updateExact([
            { bindingId: binding.bindingId, expected: binding, next: { ...binding, boundHash: "f".repeat(64) } },
          ])
        ).status,
      ).toBe("ready");
    }
    const projectBefore = await treeDigest(fixture.projectRoot);
    const sourceBefore = await treeDigest(fixture.sourceRoot);
    expect((await applyPreview(preview)).status).not.toBe("applied");
    expect(await treeDigest(fixture.projectRoot)).toBe(projectBefore);
    expect(await treeDigest(fixture.sourceRoot)).toBe(sourceBefore);
  });

  it("retains one canonical result and receipt after coordinator restart and repeated apply", async () => {
    const fixture = await managedFixture();
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Local note.\n");
    const preview = await previewIntent(resolutionIntent(fixture, "use-canonical"));
    const result = await applyPreview(preview);
    expect(result.status).toBe("applied");
    await registerOperations(fixture);
    const repeated = await applyPreview(preview);
    expect(repeated.operationId).toBe(result.operationId);
    expect(repeated.receiptIds).toEqual(result.receiptIds);
    expect(await handlers.get(channels.result)!({}, { intentId: result.intentId })).toMatchObject({
      status: "applied",
      receiptIds: result.receiptIds,
    });
  });

  it("withholds consent when the granted project disappears after preview", async () => {
    const fixture = await managedFixture();
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Local note.\n");
    const preview = await previewIntent(resolutionIntent(fixture, "use-canonical"));
    const before = await treeDigest(fixture.projectRoot);
    await rename(fixture.projectRoot, fixture.projectRoot + "-offline");
    try {
      expect((await applyPreview(preview)).status).not.toBe("applied");
      expect(await treeDigest(fixture.projectRoot + "-offline")).toBe(before);
    } finally {
      await rename(fixture.projectRoot + "-offline", fixture.projectRoot);
    }
  });
});
