import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { handlers } from "../ipc/apply-ipc-helpers";
import { applyPreview, previewIntent } from "./skill-resolution-fixture";
import {
  claudeSkill,
  observedSkillId,
  projectSkill,
  registerOperations,
  seedFixture,
  sourcePackage,
  sourceSkill,
  treeDigest,
} from "./skill-adoption-fixture";
import { SKILL_MANAGEMENT_IPC_CHANNELS as channels } from "../../src/shared/skill-management-ipc";

afterEach(() => vi.resetModules());

it("reviews one unbound copy, links it to the selected source, and retains one result across restart", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  await registerOperations(fixture);
  const localPath = join(fixture.projectRoot, projectSkill);
  const otherPath = join(fixture.projectRoot, claudeSkill);
  const sourcePath = join(fixture.sourceRoot, sourcePackage, sourceSkill);
  await writeFile(join(localPath, "notes.md"), "Local edit.\r\n");
  await writeFile(join(sourcePath, "support/source-only.md"), "New source file.\n");
  await mkdir(join(sourcePath, "new/nested"), { recursive: true });
  await writeFile(join(sourcePath, "new/nested/empty.md"), "");
  await writeFile(join(localPath, "local-only.md"), "Local file to recover.\r\n");
  await mkdir(join(localPath, "keep-empty"));
  await mkdir(join(localPath, ".git"));
  await writeFile(join(localPath, ".git/keep"), "Local Git metadata.\n");
  const beforeLocal = await treeDigest(localPath);
  const beforeOther = await treeDigest(otherPath);
  const beforeSource = await treeDigest(fixture.sourceRoot);
  const beforeLogicalId = skillId;
  const preview = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "link-canonical",
      skillId,
      source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") throw new Error("Expected a reviewed canonical-link effect.");
  expect(preview.steps[0]).toMatchObject({
    plan: { kind: "link-skill" },
    unboundResolutionEvidence: { priorManagement: { use: "absent", binding: "absent", base: "unknown" } },
  });
  expect(preview.steps[0]?.files.map(({ relativePath }) => relativePath)).toContain(
    `${projectSkill}/support/source-only.md`,
  );

  const result = await applyPreview(preview);
  expect(result.status, JSON.stringify(result)).toBe("applied");
  expect(result.link).toMatchObject({ choice: "link-canonical", skillId: beforeLogicalId, status: "applied" });
  expect(await readFile(join(localPath, "notes.md"), "utf8")).toBe("Support note.\n");
  expect(await readFile(join(localPath, "support/source-only.md"), "utf8")).toBe("New source file.\n");
  expect(await treeDigest(otherPath)).toBe(beforeOther);
  expect(await treeDigest(fixture.sourceRoot)).toBe(beforeSource);

  await registerOperations(fixture);
  expect(await handlers.get(channels.result)!({}, { intentId: result.intentId })).toMatchObject({
    status: "applied",
    operationId: result.operationId,
    receiptIds: result.receiptIds,
    link: { skillId: beforeLogicalId, status: "applied" },
  });
  expect(await applyPreview(preview)).toMatchObject({
    status: "applied",
    operationId: result.operationId,
    receiptIds: result.receiptIds,
  });
  const restore = await previewIntent({ kind: "restore", operationId: result.operationId });
  expect(restore.status, restore.status === "ready" ? "" : restore.reason).toBe("ready");
  if (restore.status !== "ready") throw new Error("Expected a public-parent D3 inverse preview.");
  expect(restore.steps[0]?.plan.kind).toBe("restore-apply");
  expect(restore.steps[0]?.files.find((file) => file.relativePath.endsWith("/local-only.md"))).toMatchObject({
    change: "add",
  });
  expect(restore.steps[0]?.files.find((file) => file.relativePath.endsWith("/new/nested/empty.md"))).toMatchObject({
    change: "delete",
  });
  expect(restore.steps[0]?.files.find((file) => file.relativePath.endsWith("/notes.md"))?.diff).toContain(
    "+Local edit.",
  );
  const restored = await applyPreview(restore);
  expect(restored.status, JSON.stringify(restored)).toBe("restored");
  expect(restored.link).toMatchObject({ skillId: beforeLogicalId, status: "restored" });
  expect(await treeDigest(localPath)).toBe(beforeLocal);
  expect(await treeDigest(otherPath)).toBe(beforeOther);
  expect(await treeDigest(fixture.sourceRoot)).toBe(beforeSource);
  expect((await stat(join(localPath, "keep-empty"))).isDirectory()).toBe(true);
  await expect(stat(join(localPath, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
  const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
  expect(
    await createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")).read(),
  ).toMatchObject({ status: "ready", state: { uses: [] } });
  expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toMatchObject({
    status: "ready",
    bindings: [],
  });
}, 60_000); // Restart plus several operations; the shared 20 s helper timeout fails under machine load.

it("routes an equal tree through C adoption and restores from the link parent", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  await registerOperations(fixture);
  const beforeLocal = await treeDigest(join(fixture.projectRoot, projectSkill));
  const preview = await previewIntent({
    kind: "reconcile",
    request: {
      choice: "link-canonical",
      skillId,
      source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  });
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") throw new Error("Expected exact-copy adoption review.");
  expect(preview.steps[0]).toMatchObject({ plan: { kind: "adopt-skill" }, files: [] });
  const result = await applyPreview(preview);
  expect(result.status, JSON.stringify(result)).toBe("applied");
  expect(result.receipts?.[0]).toMatchObject({ kind: "adopt-skill", adoption: { intentId: result.intentId } });

  const restore = await previewIntent({ kind: "restore", operationId: result.operationId });
  expect(restore.status).toBe("ready");
  if (restore.status !== "ready") throw new Error("Expected public-parent adoption restore.");
  expect(await applyPreview(restore)).toMatchObject({ status: "restored" });
  expect(await treeDigest(join(fixture.projectRoot, projectSkill))).toBe(beforeLocal);
  const { createSkillRelationshipStore } = await import("../../src/main/skill-reconciliation/store");
  const { createBindingsStore, bindingsFilePath } = await import("../../src/main/bindings-store");
  expect(
    await createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json")).read(),
  ).toMatchObject({ status: "ready", state: { uses: [] } });
  expect(await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read()).toMatchObject({
    status: "ready",
    bindings: [],
  });
});
