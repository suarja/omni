import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { handlers } from "../ipc/apply-ipc-helpers";
import {
  observedSkillId,
  projectSkill,
  registerOperations,
  seedFixture,
  sourcePackage,
  treeDigest,
} from "./skill-adoption-fixture";

afterEach(() => vi.resetModules());

it("withholds inverse when the captured destination gains an unreviewed file", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  await registerOperations(fixture);
  const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
  const sourceBefore = await treeDigest(fixture.sourceRoot);
  const projectBefore = await treeDigest(fixture.projectRoot);
  const capture = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
    {},
    {
      intent: {
        kind: "reconcile",
        request: {
          choice: "keep-variant",
          skillId,
          locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
          destination: { sourceId: fixture.source.id, packageId: sourcePackage, skillKey: "captured-demo" },
        },
      },
    },
  )) as { status: string; intentId: string; effectFingerprint: string };
  expect(capture.status).toBe("ready");
  const result = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
    {},
    {
      intentId: capture.intentId,
      effectFingerprint: capture.effectFingerprint,
    },
  )) as { status: string; receiptIds: readonly string[] };
  expect(result.status).toBe("applied");

  const addedPath = join(fixture.sourceRoot, sourcePackage, "skills/captured-demo/notes-added-later.md");
  const addedBytes = Buffer.from("Keep this later user file.\n");
  await writeFile(addedPath, addedBytes);
  const sourceWithUserFile = await treeDigest(fixture.sourceRoot);
  const restore = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
    {},
    {
      intent: { kind: "restore", operationId: result.receiptIds[0] },
    },
  )) as { status: string; reason?: string };

  expect(restore.status).toBe("blocked");
  expect(restore.reason).toContain("unexpected");
  expect(await readFile(addedPath)).toEqual(addedBytes);
  expect(await treeDigest(fixture.sourceRoot)).toBe(sourceWithUserFile);
  expect(await treeDigest(fixture.projectRoot)).toBe(projectBefore);
  expect(sourceBefore).not.toBe(sourceWithUserFile);
});
