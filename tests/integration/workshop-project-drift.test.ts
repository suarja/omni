import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  seedFixture,
  registerOperations,
  observedSkillId,
  projectSkill,
  claudeSkill,
  sourcePackage,
  sourceSkill,
} from "./skill-adoption-fixture";
import { readProjectDrift } from "../../src/main/workshop-delivery/project-drift";

it("counts a changed managed copy only for its own harness", async () => {
  const fixture = await seedFixture(),
    operations = await registerOperations(fixture);
  const skillId = await observedSkillId(fixture);
  const preview = await operations.skillManagement.preview(
    {
      kind: "reconcile",
      request: {
        choice: "adopt-exact",
        skillId,
        source: { sourceId: fixture.source.id, packageId: sourcePackage, artifactPath: sourceSkill },
        locations: [
          { projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill },
          { projectId: fixture.project.id, harnessId: "claude-code", folderPath: claudeSkill },
        ],
      },
    },
    { kind: "desktop" },
  );
  if (preview.status !== "ready") throw new Error(JSON.stringify(preview));
  await operations.skillManagement.apply(preview.intentId, {
    kind: "desktop",
    effectFingerprint: preview.effectFingerprint,
    approvedAt: new Date().toISOString(),
  });
  await appendFile(join(fixture.projectRoot, projectSkill, "SKILL.md"), "\nLocal Codex change.\n");
  const report = await readProjectDrift({
    userDataPath: fixture.userDataPath,
    registry: fixture.registry,
    bindings: fixture.bindings,
  });
  const managed = report.bindings.filter((binding) => binding.projectId === fixture.project.id);
  expect(managed.filter((binding) => binding.state === "conflict").map((binding) => binding.harness)).toEqual([
    "codex",
  ]);
  expect(managed.find((binding) => binding.harness === "claude-code")?.state).toBe("current");
});
