import { cp, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { managedFixture, previewIntent, resolutionIntent } from "../integration/skill-resolution-fixture";
import { projectSkill, treeDigest } from "../integration/skill-adoption-fixture";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { createSkillBaseStore } from "../../src/main/skill-reconciliation/bases";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createOperationStore } from "../../src/main/operation-store";
import { readSkillResolutionSnapshot } from "../../src/main/skill-management/resolution-reader";
import { applyCanonicalResolution } from "../../src/main/skill-management/resolution-application";

it("preserves a substituted project root before the first canonical file effect", async () => {
  const fixture = await managedFixture();
  await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Local bytes to preserve.\n");
  const intent = resolutionIntent(fixture, "use-canonical");
  if (
    intent.kind !== "reconcile" ||
    intent.request.choice === "adopt-exact" ||
    intent.request.choice === "keep-variant" ||
    intent.request.choice === "link-canonical" ||
    intent.request.choice === "detach-managed"
  )
    throw new Error("Invalid fixture.");
  const preview = await previewIntent(intent);
  if (preview.status !== "ready") throw new Error("Resolution preview is unavailable.");
  const dependencies = {
    registry: fixture.registry,
    relationships: createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")),
    bindings: createBindingsStore(bindingsFilePath(fixture.userDataPath)),
    bases: createSkillBaseStore(fixture.userDataPath),
    operationStore: createOperationStore(join(fixture.userDataPath, "omni/operations.json")),
  };
  const snapshot = await readSkillResolutionSnapshot(intent.request, dependencies);
  if (snapshot.status !== "ready") throw new Error("Resolution snapshot is unavailable.");
  const parked = fixture.projectRoot + "-parked";
  let before = "";
  let swapped = false;
  try {
    const result = await applyCanonicalResolution({
      intentId: preview.intentId,
      step: preview.steps[0]!,
      snapshot,
      dependencies,
      now: Date.now,
      progress: async () => {
        if (swapped) return;
        swapped = true;
        await rename(fixture.projectRoot, parked);
        await cp(parked, fixture.projectRoot, { recursive: true });
        before = await treeDigest(fixture.projectRoot);
      },
    });
    expect(result.status).not.toBe("applied");
    expect(await treeDigest(fixture.projectRoot)).toBe(before);
  } finally {
    const { rm } = await import("node:fs/promises");
    if (swapped) {
      await rm(fixture.projectRoot, { recursive: true, force: true });
      await rename(parked, fixture.projectRoot);
    }
  }
});
