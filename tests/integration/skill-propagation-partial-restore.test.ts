import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createOperationStore, type OperationStore } from "../../src/main/operation-store";
import { parseSkillPreview, SKILL_MANAGEMENT_IPC_CHANNELS } from "../../src/shared/skill-management-ipc";
import type { SkillManagementService } from "../../src/application/skill-management";
import type { SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import { handlers } from "../ipc/apply-ipc-helpers";
import {
  claudeSkill,
  observedSkillId,
  projectSkill,
  registerOperations,
  seedFixture,
  sourcePackage,
  sourceSkill,
} from "./skill-adoption-fixture";

const updated = "---\nname: demo\ndescription: Updated demo skill.\n---\n# Updated demo\n";
const locations = (projectId: string) => [
  { projectId, harnessId: "codex" as const, folderPath: projectSkill },
  { projectId, harnessId: "claude-code" as const, folderPath: claudeSkill },
];

async function adopt(fixture: Awaited<ReturnType<typeof seedFixture>>, skillId: string): Promise<void> {
  const preview = parseSkillPreview(
    await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
      {},
      {
        intent: {
          kind: "reconcile",
          request: {
            choice: "adopt-exact",
            skillId,
            source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
            locations: locations(fixture.project.id),
          },
        },
      },
    ),
  );
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.reason);
  await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
    {},
    {
      intentId: preview.intentId,
      effectFingerprint: preview.effectFingerprint,
    },
  );
}

async function apply(service: SkillManagementService, preview: SkillPreview): Promise<SkillResult> {
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.reason);
  return service.apply(preview.intentId, {
    kind: "desktop",
    effectFingerprint: preview.effectFingerprint,
    approvedAt: new Date().toISOString(),
  });
}

async function prepareReadOnlyResult(): Promise<
  Readonly<{
    fixture: Awaited<ReturnType<typeof seedFixture>>;
    service: SkillManagementService;
    result: SkillResult;
    before: Buffer;
  }>
> {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  const { skillManagement: service } = await registerOperations(fixture);
  await adopt(fixture, skillId);
  const before = await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"));
  await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), updated);
  await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "support/payload.bin"), Buffer.from([7, 0, 9]));
  const preview = await service.preview(
    {
      kind: "maintain-current",
      source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
    },
    { kind: "desktop" },
  );
  const folder = join(fixture.projectRoot, claudeSkill);
  const paths = [
    folder,
    join(folder, "support"),
    join(folder, "SKILL.md"),
    join(folder, "notes.md"),
    join(folder, "support/payload.bin"),
  ];
  try {
    for (const path of paths) await chmod(path, path === folder || path.endsWith("/support") ? 0o555 : 0o444);
    return { fixture, service, before, result: await apply(service, preview) };
  } finally {
    for (const path of paths) await chmod(path, path === folder || path.endsWith("/support") ? 0o755 : 0o644);
  }
}

describe("partial propagation restore", () => {
  it("reports a read-only copy as failed before replacement and retries only that location", async () => {
    const { fixture, service, result, before } = await prepareReadOnlyResult();
    expect(result.status).toBe("partial");
    expect(result.recoveryAvailable).toBe(false);
    expect(result.propagation?.targets.map(({ location, result }) => [location.harnessId, result])).toEqual([
      ["claude-code", "failed"],
      ["codex", "applied"],
    ]);
    expect(result.issues[0]?.message).toContain("EACCES");
    expect(result.propagation?.targets.find(({ result }) => result === "failed")?.reason).toContain("EACCES");
    const receipts = await createOperationStore(join(fixture.userDataPath, "omni/operations.json")).read();
    if (receipts.status !== "ready") throw new Error(receipts.diagnostic);
    expect(receipts.receipts.find(({ operationId }) => operationId === result.intentId)?.displayTarget).toBe(
      "Update linked copies · demo",
    );
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"))).toEqual(before);
    const retry = await service.preview(
      {
        kind: "maintain-current",
        source: result.propagation!.source,
        locations: [locations(fixture.project.id)[1]!],
        retryOf: result.intentId,
      },
      { kind: "desktop" },
    );
    if (retry.status !== "ready") throw new Error(retry.reason);
    expect(retry.scope.targets).toEqual([
      { projectId: fixture.project.id, harnessId: "claude-code", bindingId: expect.any(String) },
    ]);
    expect((await apply(service, retry)).propagation).toMatchObject({
      retryOf: result.intentId,
      targets: [{ result: "applied" }],
    });
    expect((await service.readResult(result.intentId))?.propagation?.targets[0]?.result).toBe("failed");
  });

  it("previews and restores only verified applied effects after a partial result and restart", async () => {
    const { fixture, result, before } = await prepareReadOnlyResult();
    const { skillManagement: service } = await registerOperations(fixture);
    const preview = parseSkillPreview(
      await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
        {},
        {
          intent: { kind: "restore", operationId: result.operationId },
        },
      ),
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.reason);
    expect(preview.steps).toHaveLength(1);
    expect(preview.scope.targets.map(({ harnessId }) => harnessId)).toEqual(["codex"]);
    expect(preview.steps[0]?.files.find(({ relativePath }) => relativePath.endsWith("SKILL.md"))?.diff).toContain(
      "-# Updated demo",
    );
    expect(preview.steps[0]?.files.find(({ relativePath }) => relativePath.endsWith("payload.bin"))?.diff).toContain(
      "binary content restored",
    );
    const childPreview = await service.preview(
      { kind: "restore", operationId: result.receiptIds[0]! },
      { kind: "desktop" },
    );
    expect(childPreview.status).toBe("ready");
    if (childPreview.status !== "ready") throw new Error(childPreview.reason);
    expect(childPreview.propagation).toMatchObject({
      source: result.propagation!.source,
      targets: [{ result: "applied" }],
    });
    const restored = await apply(service, preview);
    expect(restored.status).toBe("restored");
    expect(restored.propagation?.targets.map(({ result }) => result)).toEqual(["failed", "restored"]);
    for (const folder of [projectSkill, claudeSkill])
      expect(await readFile(join(fixture.projectRoot, folder, "SKILL.md"))).toEqual(before);
    const saved = await service.readResult(result.intentId);
    expect(saved?.propagation?.targets.map(({ result }) => result)).toEqual(["failed", "restored"]);
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), "utf8")).toBe(updated);
  });

  it("restores the verified peer while an unrecorded post-write effect remains in recovery", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const store = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
    const interruptedStore: OperationStore = {
      read: () => store.read(),
      markRestored: (id) => store.markRestored(id),
      append: (receipt) =>
        receipt.kind === "propagate-skill" && receipt.skillPropagation?.location.harnessId === "codex"
          ? Promise.resolve({
              status: "corrupt",
              diagnostic: "Receipt persistence failed after replacement.",
              recoveryAvailable: false,
            })
          : store.append(receipt),
    };
    const { skillManagement: service } = await registerOperations(fixture, interruptedStore);
    await adopt(fixture, skillId);
    const before = await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"));
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), updated);
    const result = await apply(
      service,
      await service.preview(
        {
          kind: "maintain-current",
          source: {
            sourceId: fixture.source.id,
            packageId: sourcePackage,
            artifactPath: sourceSkill,
          },
        },
        { kind: "desktop" },
      ),
    );
    expect(result.status).toBe("recovery-required");
    expect(result.propagation?.targets.map(({ result }) => result)).toEqual(["applied", "unknown"]);
    const preview = parseSkillPreview(
      await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
        {},
        {
          intent: { kind: "restore", operationId: result.intentId },
        },
      ),
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.reason);
    expect(preview.scope.targets.map(({ harnessId }) => harnessId)).toEqual(["claude-code"]);
    expect(preview.propagation?.targets.map(({ result }) => result)).toEqual(["applied", "unknown"]);
    expect(await apply(service, preview)).toMatchObject({
      status: "recovery-required",
      recoveryAvailable: true,
      propagation: { targets: [{ result: "restored" }, { result: "unknown" }] },
    });
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"))).toEqual(before);
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).toBe(updated);
    const reopened = (await registerOperations(fixture)).skillManagement;
    expect(await reopened.readResult(result.intentId)).toMatchObject({
      status: "recovery-required",
      recoveryAvailable: true,
      propagation: { targets: [{ result: "restored" }, { result: "unknown" }] },
    });
    const secondRestore = await reopened.preview(
      { kind: "restore", operationId: result.intentId },
      { kind: "desktop" },
    );
    expect(secondRestore.status).toBe("blocked");
    if (secondRestore.status === "blocked") expect(secondRestore.reason).toContain("no verified applied effects");
  });
});
