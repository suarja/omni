import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { readSkillVariantSnapshot } from "../../src/main/skill-management/variant-reader";
import { createBindingsStore, bindingsFilePath } from "../../src/main/bindings-store";
import { createSkillRelationshipStore } from "../../src/main/skill-reconciliation/store";
import { observedSkillId, projectSkill, seedFixture, sourcePackage } from "../integration/skill-adoption-fixture";

afterEach(() => vi.resetModules());

it("reads the exact unmanaged copy and current Omni destination without inventing management records", async () => {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  const relationships = createSkillRelationshipStore(join(fixture.userDataPath, "omni/skill-relationships.json"));
  const bindings = createBindingsStore(bindingsFilePath(fixture.userDataPath));
  const result = await readSkillVariantSnapshot(
    {
      choice: "keep-variant",
      skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
      destination: { sourceId: fixture.source.id, packageId: sourcePackage, skillKey: "personal-demo" },
    },
    { registry: fixture.registry, relationships, bindings },
  );

  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.source).toEqual({
    sourceId: fixture.source.id,
    packageId: sourcePackage,
    artifactPath: "skills/personal-demo",
  });
  expect(result.packageRoot).toBe(sourcePackage);
  expect(result.localTree.revision.files.map(({ path }) => path)).toEqual([
    "notes.md",
    "SKILL.md",
    "support/payload.bin",
  ]);
  expect(result.use).toBeUndefined();
  expect(result.binding).toBeUndefined();
  expect(result.record.locations).toEqual(
    expect.arrayContaining([expect.objectContaining({ projectId: fixture.project.id, folderPath: projectSkill })]),
  );
});
