import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import type { SkillPreview } from "../../src/shared/skill-management-ipc";
import { projectSkill, registerOperations } from "./skill-adoption-fixture";
import { managedFixture } from "./skill-resolution-fixture";

function authorization(preview: SkillPreview) {
  if (preview.status !== "ready") throw new Error("Expected a ready preview.");
  return {
    kind: "desktop" as const,
    effectFingerprint: preview.effectFingerprint,
    approvedAt: new Date().toISOString(),
  };
}

function detachIntent(fixture: Awaited<ReturnType<typeof managedFixture>>) {
  return {
    kind: "reconcile" as const,
    request: {
      choice: "detach-managed" as const,
      skillId: fixture.skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill }] as const,
    },
  };
}

async function addGitConfig(projectRoot: string): Promise<string> {
  const gitDirectory = join(projectRoot, projectSkill, ".git");
  await mkdir(gitDirectory, { recursive: true });
  const config = join(gitDirectory, "config");
  await writeFile(config, "repository-config-A\n");
  return config;
}

it("rejects the old approval after a same-inode .git file edit and preserves tracking", async () => {
  const fixture = await managedFixture();
  const config = await addGitConfig(fixture.projectRoot);
  const operations = await registerOperations(fixture);
  const relationshipsStore = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
  const bindingsStore = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  const relationshipsBefore = await relationshipsStore.read();
  const bindingsBefore = await bindingsStore.read();
  expect(relationshipsBefore.status).toBe("ready");
  expect(bindingsBefore.status).toBe("ready");
  const preview = await operations.skillManagement.preview(detachIntent(fixture), { kind: "desktop" });
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") return;
  const inodeBefore = (await stat(config)).ino;
  await writeFile(config, "repository-config-B\n");
  expect((await stat(config)).ino).toBe(inodeBefore);

  const result = await operations.skillManagement.apply(preview.intentId, authorization(preview));
  expect(result.status).not.toBe("applied");
  expect(await relationshipsStore.read()).toEqual(relationshipsBefore);
  expect(await bindingsStore.read()).toEqual(bindingsBefore);
  expect(await readFile(config, "utf8")).toBe("repository-config-B\n");
});

it("withholds inverse preview after a same-inode .git file edit", async () => {
  const fixture = await managedFixture();
  const config = await addGitConfig(fixture.projectRoot);
  const operations = await registerOperations(fixture);
  const service = operations.skillManagement;
  const detached = await service.preview(detachIntent(fixture), { kind: "desktop" });
  expect(detached.status).toBe("ready");
  if (detached.status !== "ready") return;
  const result = await service.apply(detached.intentId, authorization(detached));
  expect(result.status).toBe("applied");

  const inodeBefore = (await stat(config)).ino;
  await writeFile(config, "repository-config-B\n");
  expect((await stat(config)).ino).toBe(inodeBefore);
  const inverse = await service.preview({ kind: "restore", operationId: detached.intentId }, { kind: "desktop" });
  expect(inverse.status).toBe("blocked");
});

it("rejects a symlink inside the selected copy's .git directory", async () => {
  const fixture = await managedFixture();
  const gitDirectory = join(fixture.projectRoot, projectSkill, ".git");
  await mkdir(gitDirectory, { recursive: true });
  await symlink("outside", join(gitDirectory, "linked"));
  const operations = await registerOperations(fixture);
  const preview = await operations.skillManagement.preview(detachIntent(fixture), { kind: "desktop" });
  expect(preview.status).toBe("blocked");
});

it("rejects a .git file beyond the bounded per-file read size", async () => {
  const fixture = await managedFixture();
  const gitDirectory = join(fixture.projectRoot, projectSkill, ".git");
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(join(gitDirectory, "oversized"), Buffer.alloc(1024 * 1024 + 1));
  const operations = await registerOperations(fixture);
  const preview = await operations.skillManagement.preview(detachIntent(fixture), { kind: "desktop" });
  expect(preview.status).toBe("blocked");
});
