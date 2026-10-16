import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { handlers } from "../ipc/apply-ipc-helpers";
import { root } from "../ipc/apply-ipc-helpers";
import {
  sourcePackage,
  sourceSkill,
  projectSkill,
  claudeSkill,
  seedFixture,
  observedSkillId,
  registerOperations,
} from "./skill-adoption-fixture";

const locations = (projectId: string) =>
  [
    { projectId, harnessId: "codex", folderPath: projectSkill },
    { projectId, harnessId: "claude-code", folderPath: claudeSkill },
  ] as const;

describe("linked skill propagation journey", () => {
  it("maintains one source across distinct logical skills and keeps retry and restore target-specific", async () => {
    const fixture = await seedFixture();
    const firstSkillId = await observedSkillId(fixture);
    const operations = await registerOperations(fixture);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
    const adoptProject = async (projectId: string, skillId: string): Promise<void> => {
      const preview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
        {},
        {
          intent: {
            kind: "reconcile",
            request: { choice: "adopt-exact", skillId, source, locations: locations(projectId) },
          },
        },
      )) as { status: string; intentId: string; effectFingerprint: string };
      expect(preview.status).toBe("ready");
      await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
        {},
        { intentId: preview.intentId, effectFingerprint: preview.effectFingerprint },
      );
    };
    await adoptProject(fixture.project.id, firstSkillId);

    const secondRoot = await root("project-second");
    const secondProject = await fixture.registerProjectRoot(secondRoot);
    for (const folder of [projectSkill, claudeSkill]) {
      const sourceDir = join(fixture.projectRoot, folder);
      const targetDir = join(secondRoot, folder);
      await mkdir(targetDir, { recursive: true });
      for (const name of ["SKILL.md", "notes.md", "support/payload.bin"]) {
        const bytes = await readFile(join(sourceDir, name));
        await mkdir(join(targetDir, name, ".."), { recursive: true });
        await writeFile(join(targetDir, name), bytes);
      }
    }
    const secondSkillId = await observedSkillId(fixture, secondProject);
    expect(secondSkillId).not.toBe(firstSkillId);
    await adoptProject(secondProject.id, secondSkillId);
    const projectLocations = [...locations(fixture.project.id), ...locations(secondProject.id)];
    await writeFile(join(secondRoot, claudeSkill, "SKILL.md"), "---\nname: demo\n---\n# Local second edit\n");
    const updatedSource = "---\nname: demo\ndescription: Updated for source-wide maintenance.\n---\n# Updated\n";
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), updatedSource);
    const intent = { kind: "maintain-current" as const, source };
    const availablePreview = await operations.skillManagement.preview(intent, { kind: "desktop" });
    expect(availablePreview.status).toBe("ready");
    if (availablePreview.status !== "ready") throw new Error("The available source-wide preview was not ready.");
    const availableTargets = availablePreview.propagation?.targets ?? [];
    expect(availableTargets.filter(({ skillId }) => skillId === firstSkillId).map(({ state }) => state)).toEqual([
      "eligible",
      "eligible",
    ]);
    expect(
      availableTargets
        .filter(({ skillId }) => skillId === secondSkillId)
        .map(({ state }) => state)
        .sort(),
    ).toEqual(["eligible", "retained-local"]);

    const movedRoot = secondRoot + "-moved";
    await rename(secondRoot, movedRoot);
    const preview = await operations.skillManagement.preview(intent, { kind: "desktop" });
    expect(preview.status, JSON.stringify(preview)).toBe("ready");
    if (preview.status !== "ready") throw new Error("Source-wide maintenance was not ready.");
    expect(preview.propagation?.targets.map(({ skillId, state }) => ({ skillId, state }))).toEqual([
      { skillId: firstSkillId, state: "eligible" },
      { skillId: firstSkillId, state: "eligible" },
      { skillId: secondSkillId, state: "unavailable" },
      { skillId: secondSkillId, state: "unavailable" },
    ]);
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("partial");
    expect(result.receipts?.filter(({ kind }) => kind === "propagate-skill")).toHaveLength(2);
    expect(
      result.receipts
        ?.filter(({ kind }) => kind === "propagate-skill")
        .map(({ skillPropagation }) => skillPropagation?.skillId),
    ).toEqual([firstSkillId, firstSkillId]);
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).toBe(updatedSource);
    expect(await readFile(join(movedRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("Local second edit");

    await rename(movedRoot, secondRoot);
    const retry = await operations.skillManagement.preview(
      { kind: "maintain-current", source, locations: [projectLocations[2]!], retryOf: result.intentId },
      { kind: "desktop" },
    );
    expect(retry.status).toBe("ready");
    if (retry.status !== "ready") throw new Error("The repaired project use was not retryable.");
    expect(retry.scope.targets).toEqual([
      { projectId: secondProject.id, harnessId: "codex", bindingId: expect.any(String) },
    ]);
    const retryResult = await operations.skillManagement.apply(retry.intentId, {
      kind: "desktop",
      effectFingerprint: retry.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(retryResult.propagation?.targets).toMatchObject([{ skillId: secondSkillId, result: "applied" }]);
    expect(retryResult.receipts?.find(({ kind }) => kind === "propagate-skill")?.skillPropagation?.skillId).toBe(
      secondSkillId,
    );
    expect(await readFile(join(secondRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("Local second edit");

    const restore = await operations.skillManagement.preview(
      { kind: "restore", operationId: retryResult.operationId },
      { kind: "desktop" },
    );
    expect(restore.status).toBe("ready");
    if (restore.status !== "ready") throw new Error("The targeted retry restore was not reviewable.");
    const restored = await operations.skillManagement.apply(restore.intentId, {
      kind: "desktop",
      effectFingerprint: restore.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(restored.status).toBe("restored");
    expect(await readFile(join(secondRoot, projectSkill, "SKILL.md"), "utf8")).toContain("# Demo");
    expect(await readFile(join(secondRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("Local second edit");

    const restoreFirst = await operations.skillManagement.preview(
      { kind: "restore", operationId: result.operationId },
      { kind: "desktop" },
    );
    expect(restoreFirst.status).toBe("ready");
    if (restoreFirst.status !== "ready") throw new Error("The original operation restore was not reviewable.");
    expect(
      (
        await operations.skillManagement.apply(restoreFirst.intentId, {
          kind: "desktop",
          effectFingerprint: restoreFirst.effectFingerprint,
          approvedAt: new Date().toISOString(),
        })
      ).status,
    ).toBe("restored");
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).not.toBe("updated source\n");
  });

  it("advances only the verified base when a linked project already has the current complete tree", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const operations = await registerOperations(fixture);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
    const adoptPreview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: {
          kind: "reconcile",
          request: { choice: "adopt-exact", skillId, source, locations: locations(fixture.project.id) },
        },
      },
    )) as { intentId: string; effectFingerprint: string };
    await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      { intentId: adoptPreview.intentId, effectFingerprint: adoptPreview.effectFingerprint },
    );

    const currentSkill = "---\nname: demo\ndescription: Current linked skill.\n---\n# Demo\n";
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), currentSkill);
    for (const path of [projectSkill, claudeSkill])
      await writeFile(join(fixture.projectRoot, path, "SKILL.md"), currentSkill);

    const preview = await operations.skillManagement.preview(
      { kind: "maintain-current", source, locations: locations(fixture.project.id) },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("The already-current copies were not reviewable.");
    expect(preview.propagation?.targets.map(({ state }) => state)).toEqual(["already-current", "already-current"]);
    expect(preview.steps).toHaveLength(2);
    expect(preview.steps.map(({ plan }) => plan.actions)).toEqual([[], []]);
    expect(
      preview.steps.every(
        ({ metadataEffects }) =>
          metadataEffects?.[0]?.before?.baseRevisionId !== metadataEffects?.[0]?.after?.baseRevisionId,
      ),
    ).toBe(true);

    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result).toMatchObject({
      status: "applied",
      propagation: { targets: [{ result: "applied" }, { result: "applied" }] },
    });
    expect(result.receipts?.every((receipt) => receipt.skillPropagation !== undefined)).toBe(true);

    const restorePreview = await operations.skillManagement.preview(
      { kind: "restore", operationId: result.operationId },
      { kind: "desktop" },
    );
    expect(restorePreview.status).toBe("ready");
    if (restorePreview.status !== "ready") throw new Error("The base-only propagation restore was not reviewable.");
    expect(restorePreview.steps.every(({ plan }) => plan.actions.length === 0)).toBe(true);
    const restored = await operations.skillManagement.apply(restorePreview.intentId, {
      kind: "desktop",
      effectFingerprint: restorePreview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(restored.status).toBe("restored");
    for (const path of [projectSkill, claudeSkill])
      expect(await readFile(join(fixture.projectRoot, path, "SKILL.md"), "utf8")).toBe(currentSkill);
  });

  it("reviews one source update before maintaining both linked project trees and restores the aggregate", async () => {
    const fixture = await seedFixture();
    const untouchedBinary = Buffer.from([4, 0, 6]);
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/untouched.bin"), untouchedBinary);
    for (const path of [projectSkill, claudeSkill])
      await writeFile(join(fixture.projectRoot, path, "support/untouched.bin"), untouchedBinary);
    const skillId = await observedSkillId(fixture);
    const operations = await registerOperations(fixture);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
    const adoptPreview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: {
          kind: "reconcile",
          request: { choice: "adopt-exact", skillId, source, locations: locations(fixture.project.id) },
        },
      },
    )) as { status: string; intentId: string; effectFingerprint: string };
    expect(adoptPreview.status).toBe("ready");
    const adopted = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: adoptPreview.intentId,
        effectFingerprint: adoptPreview.effectFingerprint,
      },
    )) as { status: string };
    expect(adopted.status).toBe("applied");
    expect(await operations.skillManagement.readPropagationCandidates?.(source)).toEqual([
      { skillId, locations: [locations(fixture.project.id)[1], locations(fixture.project.id)[0]] },
    ]);
    expect(await operations.skillManagement.readPropagationCandidates?.(source)).toEqual([
      { skillId, locations: [locations(fixture.project.id)[1], locations(fixture.project.id)[0]] },
    ]);

    const intent = {
      kind: "update-and-maintain",
      source,
      request: {
        kind: "write-skill",
        sourceId: fixture.source.id,
        packageId: sourcePackage,
        mode: "update",
        folderName: "demo",
        files: [
          { path: "SKILL.md", content: "---\nname: demo\ndescription: Updated demo skill.\n---\n# Demo\n" },
          { path: "notes.md", content: "Updated source note.\n" },
          { path: "support/payload.bin", content: Buffer.from([9, 0, 255]).toString("base64"), encoding: "base64" },
        ],
      },
      locations: locations(fixture.project.id),
    };
    const preview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!({}, { intent })) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
      steps?: readonly { plan: { kind: string }; propagationEvidence?: { location: { harnessId: string } } }[];
      propagation?: { targets: readonly { state: string }[] };
      reason?: string;
      details?: readonly unknown[];
    };
    expect(preview.status, JSON.stringify(preview)).toBe("ready");
    expect(preview.steps?.map(({ plan }) => plan.kind)).toEqual(["write-skill", "propagate-skill", "propagate-skill"]);
    expect(preview.propagation?.targets.map(({ state }) => state)).toEqual(["eligible", "eligible"]);
    expect(preview.steps?.slice(1).map(({ propagationEvidence }) => propagationEvidence?.location.harnessId)).toEqual([
      "claude-code",
      "codex",
    ]);
    const result = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    )) as {
      status: string;
      operationId: string;
      receiptIds: readonly string[];
      source: { status: string };
      targets: readonly { status: string }[];
      propagation?: { targets: readonly { result?: string }[] };
    };
    expect(result).toMatchObject({
      status: "applied",
      source: { status: "updated" },
      targets: [{ status: "applied" }, { status: "applied" }],
      propagation: { targets: [{ result: "applied" }, { result: "applied" }] },
    });
    const binary = Buffer.from([0, 1, 255, 3]);
    const updatedBinary = Buffer.from([9, 0, 255]);
    for (const path of [projectSkill, claudeSkill]) {
      expect(await readFile(join(fixture.projectRoot, path, "notes.md"), "utf8")).toBe("Updated source note.\n");
      expect(await readFile(join(fixture.projectRoot, path, "support/payload.bin"))).toEqual(updatedBinary);
      expect(await readFile(join(fixture.projectRoot, path, "support/untouched.bin"))).toEqual(untouchedBinary);
    }
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/payload.bin"))).toEqual(
      updatedBinary,
    );
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/untouched.bin"))).toEqual(
      untouchedBinary,
    );
    const replay = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    )) as { status: string; receiptIds: readonly string[] };
    expect(replay).toMatchObject({ status: "applied", receiptIds: result.receiptIds });
    const reopenedOperations = await registerOperations(fixture);
    expect(await reopenedOperations.skillManagement.readResult(result.operationId)).toMatchObject({
      status: "applied",
      propagation: { targets: [{ result: "applied" }, { result: "applied" }] },
    });
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Later local edit.\n");
    const guardedRestore = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: { kind: "restore", operationId: result.operationId },
      },
    )) as { status: string; reason?: string };
    expect(guardedRestore.status).toBe("blocked");
    expect(guardedRestore.reason).toContain("changed after");
    expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"), "utf8")).toBe("Later local edit.\n");
    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Updated source note.\n");

    const restorePreview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: { kind: "restore", operationId: result.operationId },
      },
    )) as {
      status: string;
      intentId: string;
      effectFingerprint: string;
      steps?: readonly { files: readonly { relativePath: string; diff?: string }[] }[];
    };
    expect(restorePreview.status).toBe("ready");
    expect(
      restorePreview.steps
        ?.flatMap(({ files }) => files)
        .find(
          (action) =>
            action.relativePath.startsWith("packages/") && action.relativePath.endsWith("support/payload.bin"),
        )?.diff,
    ).toContain("binary content restored (4 bytes)");
    const restored = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      {
        intentId: restorePreview.intentId,
        effectFingerprint: restorePreview.effectFingerprint,
      },
    )) as { status: string; issues?: readonly unknown[]; targets?: readonly unknown[] };
    expect(restored.status, JSON.stringify(restored)).toBe("restored");
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "notes.md"), "utf8")).toBe(
      "Support note.\n",
    );
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/payload.bin"))).toEqual(binary);
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/untouched.bin"))).toEqual(
      untouchedBinary,
    );
    for (const path of [projectSkill, claudeSkill]) {
      expect(await readFile(join(fixture.projectRoot, path, "notes.md"), "utf8")).toBe("Support note.\n");
      expect(await readFile(join(fixture.projectRoot, path, "support/payload.bin"))).toEqual(binary);
      expect(await readFile(join(fixture.projectRoot, path, "support/untouched.bin"))).toEqual(untouchedBinary);
    }
    expect((await reopenedOperations.skillManagement.readResult(result.operationId))?.status).toBe("restored");
  });

  it("withholds every target after post-source drift and retries one repaired target under retryOf", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    let changedProject = false;
    const fileWriter = async (
      path: string,
      content: string | Uint8Array,
      options: { encoding?: BufferEncoding; mode?: number },
    ): Promise<void> => {
      await writeFile(path, content, options);
      if (!changedProject && path.includes("/SKILL.md.")) {
        changedProject = true;
        await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Concurrent local edit.\n");
      }
    };
    const operations = await registerOperations(fixture, undefined, fileWriter);
    const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
    const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
    const adoptPreview = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: {
          kind: "reconcile",
          request: { choice: "adopt-exact", skillId, source, locations: locations(fixture.project.id) },
        },
      },
    )) as { status: string; intentId: string; effectFingerprint: string };
    expect(adoptPreview.status).toBe("ready");
    await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
      {},
      { intentId: adoptPreview.intentId, effectFingerprint: adoptPreview.effectFingerprint },
    );

    const updateIntent = {
      kind: "update-and-maintain",
      source,
      request: {
        kind: "write-skill",
        sourceId: fixture.source.id,
        packageId: sourcePackage,
        mode: "update",
        folderName: "demo",
        files: [{ path: "SKILL.md", content: "---\nname: demo\ndescription: Updated demo skill.\n---\n# Demo\n" }],
      },
      locations: locations(fixture.project.id),
    };
    const preview = await operations.skillManagement.preview(updateIntent, { kind: "desktop" });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("The linked source update was not ready.");
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("partial");
    expect(result.source.status).toBe("updated");
    expect(result.propagation?.targets.map(({ result: status }) => status)).toEqual(["pending", "pending"]);
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("# Demo");

    await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Support note.\n");
    const retried = await operations.skillManagement.preview(
      {
        kind: "maintain-current",
        source,
        locations: [locations(fixture.project.id)[0]],
        retryOf: result.intentId,
      },
      { kind: "desktop" },
    );
    expect(retried.status).toBe("ready");
    if (retried.status !== "ready") throw new Error("The repaired target was not retryable.");
    expect(retried.scope.targets).toHaveLength(1);
    const retryResult = await operations.skillManagement.apply(retried.intentId, {
      kind: "desktop",
      effectFingerprint: retried.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(retryResult).toMatchObject({
      status: "applied",
      propagation: { retryOf: result.intentId, targets: [{ result: "applied" }] },
    });
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).toContain(
      "Updated demo skill.",
    );
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("# Demo");
  });
});
