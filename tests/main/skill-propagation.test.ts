import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createOperationStore, type OperationStore } from "../../src/main/operation-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { handlers } from "../ipc/apply-ipc-helpers";
import {
  sourcePackage,
  sourceSkill,
  projectSkill,
  claudeSkill,
  seedFixture,
  observedSkillId,
  registerOperations,
} from "../integration/skill-adoption-fixture";

const locations = (projectId: string) =>
  [
    { projectId, harnessId: "codex", folderPath: projectSkill },
    { projectId, harnessId: "claude-code", folderPath: claudeSkill },
  ] as const;

async function adoptBoth(fixture: Awaited<ReturnType<typeof seedFixture>>, skillId: string): Promise<void> {
  const { SKILL_MANAGEMENT_IPC_CHANNELS } = await import("../../src/shared/skill-management-ipc");
  const response = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.preview)!(
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
  )) as { status: string; intentId: string; effectFingerprint: string };
  expect(response.status).toBe("ready");
  const result = (await handlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.apply)!(
    {},
    {
      intentId: response.intentId,
      effectFingerprint: response.effectFingerprint,
    },
  )) as { status: string };
  expect(result.status).toBe("applied");
}

describe("skill propagation adapter", () => {
  it("asks for narrower scope when a source has more uses than the result contract can hold", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const operations = await registerOperations(fixture);
    await adoptBoth(fixture, skillId);
    const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
    const current = await relationships.read();
    if (current.status !== "ready") throw new Error("Managed uses were not readable.");
    const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
    const extra = Array.from({ length: 63 }, (_, index) => {
      const location = {
        projectId: `project-scope-${index}`,
        harnessId: "codex" as const,
        folderPath: `.agents/skills/scope-${index}`,
      };
      const logicalSkillId = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
      return {
        skill: {
          skillId: logicalSkillId,
          label: logicalSkillId,
          evidence: "individual" as const,
          locations: [location],
        },
        use: {
          skillId: logicalSkillId,
          bindingId: `binding-scope-${index}`,
          location,
          source,
          baseRevisionId: current.state.uses[0]!.baseRevisionId,
        },
      };
    });
    const saved = await relationships.compareAndSave(current.state.revision, [
      ...current.state.skills,
      ...extra.map(({ skill }) => skill),
    ]);
    if (saved.status !== "saved") throw new Error("Additional managed-use records could not be saved.");
    const added = await relationships.updateUsesExact(
      saved.state.revision,
      extra.map(({ use }) => ({ skillId: use.skillId, location: use.location, after: use })),
    );
    if (added.status !== "saved") throw new Error("Additional managed uses could not be saved.");

    const preview = await operations.skillManagement.preview({ kind: "maintain-current", source }, { kind: "desktop" });
    expect(preview.status).toBe("blocked");
    if (preview.status !== "blocked") throw new Error("The oversized propagation scope was not blocked.");
    expect(preview.reason).toContain("more than 64 managed uses");
    expect(preview.reason).toContain("Narrow the project locations");
  });

  it("writes only the eligible peer and preserves a retained local target", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const operations = await registerOperations(fixture);
    await adoptBoth(fixture, skillId);
    await writeFile(
      join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"),
      "---\nname: demo\ndescription: Updated demo skill.\n---\n# Demo\n",
    );
    await writeFile(join(fixture.projectRoot, claudeSkill, "notes.md"), "Local divergence.\n");
    const preview = await operations.skillManagement.preview(
      {
        kind: "maintain-current",
        source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
        locations: [
          ...locations(fixture.project.id),
          { projectId: "project-archive", harnessId: "codex", folderPath: projectSkill },
        ],
      },
      { kind: "desktop" },
    );
    expect(preview).toMatchObject({
      status: "ready",
      propagation: { targets: [{ state: "retained-local" }, { state: "eligible" }, { state: "unavailable" }] },
    });
    if (preview.status !== "ready") throw new Error("Propagation preview was not ready.");
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0]?.scope.targets).toEqual([
      { projectId: fixture.project.id, harnessId: "codex", bindingId: expect.any(String) },
    ]);
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result).toMatchObject({
      status: "partial",
      propagation: { targets: [{ result: "retained-local" }, { result: "applied" }, { result: "unavailable" }] },
    });
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "notes.md"), "utf8")).toBe("Local divergence.\n");
    expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"), "utf8")).toBe("Support note.\n");
  });

  it("does not start project writes when the owned source update fails", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const fileWriter = async (
      path: string,
      content: string | Uint8Array,
      options: { encoding?: BufferEncoding; mode?: number },
    ): Promise<void> => {
      if (path.includes("/SKILL.md.")) throw new Error("Simulated owned-source write failure.");
      await writeFile(path, content, options);
    };
    const operations = await registerOperations(fixture, undefined, fileWriter);
    await adoptBoth(fixture, skillId);
    const sourceBefore = await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), "utf8");
    const targetBefore = await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8");
    const preview = await operations.skillManagement.preview(
      {
        kind: "update-and-maintain",
        source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
        request: {
          kind: "write-skill",
          sourceId: fixture.source.id,
          packageId: sourcePackage,
          mode: "update",
          folderName: "demo",
          files: [{ path: "SKILL.md", content: "---\nname: demo\ndescription: Updated demo skill.\n---\n# Demo\n" }],
        },
        locations: locations(fixture.project.id),
      },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Source update preview was not ready.");
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(["failed", "recovery-required"]).toContain(result.status);
    expect(["failed", "unknown"]).toContain(result.source.status);
    expect(result.receipts?.some((receipt) => receipt.kind === "propagate-skill")).toBe(false);
    expect(await readFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), "utf8")).toBe(sourceBefore);
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).toBe(targetBefore);
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toBe(targetBefore);
  });

  it("keeps an independent peer result when one target receipt cannot be saved", async () => {
    const fixture = await seedFixture();
    const skillId = await observedSkillId(fixture);
    const store = createOperationStore(join(fixture.userDataPath, "omni/operations.json"));
    let failedOneTarget = false;
    const operationStore: OperationStore = {
      read: () => store.read(),
      markRestored: (operationId) => store.markRestored(operationId),
      append: (receipt) => {
        if (
          receipt.kind === "propagate-skill" &&
          receipt.project?.id === fixture.project.id &&
          receipt.skillPropagation?.location.harnessId === "codex"
        ) {
          failedOneTarget = true;
          return Promise.resolve({
            status: "corrupt",
            diagnostic: "Simulated target receipt failure.",
            recoveryAvailable: false,
          });
        }
        return store.append(receipt);
      },
    };
    const operations = await registerOperations(fixture, operationStore);
    await adoptBoth(fixture, skillId);
    await writeFile(
      join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"),
      "---\nname: demo\ndescription: Updated demo skill.\n---\n# Demo\n",
    );

    const preview = await operations.skillManagement.preview(
      {
        kind: "maintain-current",
        source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
        locations: locations(fixture.project.id),
      },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Propagation preview was not ready.");
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });

    expect(failedOneTarget).toBe(true);
    expect(result.status).toBe("recovery-required");
    expect(
      result.propagation?.targets.map(({ location, result: status }) => ({ harness: location.harnessId, status })),
    ).toEqual([
      { harness: "claude-code", status: "applied" },
      { harness: "codex", status: "unknown" },
    ]);
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).toContain(
      "Updated demo skill.",
    );
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("Updated demo skill.");
    const retry = await operations.skillManagement.preview(
      {
        kind: "maintain-current",
        source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
        locations: [locations(fixture.project.id)[0]],
        retryOf: preview.intentId,
      },
      { kind: "desktop" },
    );
    expect(retry.status).toBe("blocked");
  });
});
