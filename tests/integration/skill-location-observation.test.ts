import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { describe, expect, it } from "vitest";
import {
  seedFixture,
  observedSkillId,
  registerOperations,
  sourcePackage,
  sourceSkill,
  projectSkill,
  claudeSkill,
} from "./skill-adoption-fixture";

async function managedFixture() {
  const fixture = await seedFixture();
  await mkdir(join(fixture.projectRoot, ".cursor/skills"), { recursive: true });
  await symlink("missing-skill", join(fixture.projectRoot, ".cursor/skills/old-install"));
  const skillId = await observedSkillId(fixture);
  const operations = await registerOperations(fixture);
  const source = { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill };
  const locations = [
    { projectId: fixture.project.id, harnessId: "codex" as const, folderPath: projectSkill },
    { projectId: fixture.project.id, harnessId: "claude-code" as const, folderPath: claudeSkill },
  ];
  const adoption = await operations.skillManagement.preview(
    { kind: "reconcile", request: { choice: "adopt-exact", skillId, source, locations } },
    { kind: "desktop" },
  );
  if (adoption.status !== "ready") throw new Error("Fixture adoption must be ready.");
  await operations.skillManagement.apply(adoption.intentId, {
    kind: "desktop",
    effectFingerprint: adoption.effectFingerprint,
    approvedAt: new Date().toISOString(),
  });
  return { fixture, operations, source, skillId, locations };
}

describe("observation safety for exact skill locations", () => {
  it("updates managed Claude Code and Codex copies despite an unrelated broken Cursor link", async () => {
    const { fixture, operations, source } = await managedFixture();
    const observation = await fixture.registry.observeEntryWithGrant(
      { kind: "project", id: fixture.project.id },
      fixture.projectGrant.handle,
    );
    expect(observation.status).toBe("observed");
    if (observation.status === "observed")
      expect(observation.observation.inventory.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "broken-link", location: ".cursor/skills/old-install" }),
        ]),
      );
    const updated = "---\nname: demo\n---\n# Updated source\n";
    await writeFile(join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"), updated);
    const preview = await operations.skillManagement.preview({ kind: "maintain-current", source }, { kind: "desktop" });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Propagation must be ready.");
    expect(preview.propagation?.targets.map(({ state }) => state)).toEqual(["eligible", "eligible"]);
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.propagation?.targets.map(({ result }) => result)).toEqual(["applied", "applied"]);
    for (const folder of [projectSkill, claudeSkill])
      expect(await readFile(join(fixture.projectRoot, folder, "SKILL.md"), "utf8")).toBe(updated);
  });

  it("removes an exact managed copy despite an unrelated broken Cursor link", async () => {
    const { fixture, operations } = await managedFixture();
    const bindings = await createBindingsStore(bindingsFilePath(fixture.userDataPath)).read();
    if (bindings.status !== "ready") throw new Error("Fixture Bindings must be readable.");
    const binding = bindings.bindings.find(({ harnessId }) => harnessId === "codex");
    if (!binding) throw new Error("Fixture Binding must exist.");
    const preview = await operations.skillManagement.preview(
      { kind: "remove", bindingIds: [binding.bindingId] },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Removal must be ready.");
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("applied");
    await expect(readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(fixture.projectRoot, claudeSkill, "SKILL.md"), "utf8")).toContain("# Demo");
  });

  it("detaches one managed copy despite an unrelated broken Cursor link", async () => {
    const { fixture, operations, skillId, locations } = await managedFixture();
    const preview = await operations.skillManagement.preview(
      { kind: "reconcile", request: { choice: "detach-managed", skillId, locations: [locations[0]!] } },
      { kind: "desktop" },
    );
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Detachment must be ready.");
    const result = await operations.skillManagement.apply(preview.intentId, {
      kind: "desktop",
      effectFingerprint: preview.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe("applied");
    expect(await readFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "utf8")).toContain("# Demo");
  });

  it("keeps a symlink at the target folder unavailable without blocking another copy", async () => {
    const { fixture, operations, source } = await managedFixture();
    await rename(join(fixture.projectRoot, projectSkill), join(fixture.projectRoot, "moved-demo"));
    await symlink("../../moved-demo", join(fixture.projectRoot, projectSkill));
    await writeFile(
      join(fixture.sourceRoot, sourcePackage, sourceSkill, "SKILL.md"),
      "---\nname: demo\n---\n# Updated\n",
    );
    const preview = await operations.skillManagement.preview({ kind: "maintain-current", source }, { kind: "desktop" });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error("Propagation must be ready.");
    expect(preview.propagation?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ harnessId: "codex" }),
          state: "unavailable",
          reason: expect.any(String),
        }),
        expect.objectContaining({ location: expect.objectContaining({ harnessId: "claude-code" }), state: "eligible" }),
      ]),
    );
  });
});
