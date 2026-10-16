import { expect } from "vitest";
import { handlers } from "../ipc/apply-ipc-helpers";
import {
  seedFixture,
  observedSkillId,
  registerOperations,
  sourcePackage,
  sourceSkill,
  projectSkill,
  claudeSkill,
} from "./skill-adoption-fixture";
import {
  SKILL_MANAGEMENT_IPC_CHANNELS as channels,
  parseSkillPreview,
  parseSkillResult,
  type SkillIntent,
  type SkillPreview,
  type SkillResult,
} from "../../src/shared/skill-management-ipc";

export async function previewIntent(intent: SkillIntent): Promise<SkillPreview> {
  return parseSkillPreview(await handlers.get(channels.preview)!({}, { intent }));
}

export async function applyPreview(preview: SkillPreview): Promise<SkillResult> {
  if (preview.status !== "ready") throw new Error("The fixture preview is not ready.");
  return parseSkillResult(
    await handlers.get(channels.apply)!(
      {},
      {
        intentId: preview.intentId,
        effectFingerprint: preview.effectFingerprint,
      },
    ),
  );
}

export async function managedFixture(): Promise<Awaited<ReturnType<typeof seedFixture>> & { skillId: string }> {
  const fixture = await seedFixture();
  const skillId = await observedSkillId(fixture);
  await registerOperations(fixture);
  const preview = await previewIntent({
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
  });
  expect((await applyPreview(preview)).status).toBe("applied");
  return { ...fixture, skillId };
}

export function resolutionIntent(
  fixture: Awaited<ReturnType<typeof managedFixture>>,
  choice: "keep-local" | "use-canonical",
): SkillIntent {
  return {
    kind: "reconcile",
    request: {
      choice,
      skillId: fixture.skillId,
      locations: [{ projectId: fixture.project.id, harnessId: "codex", folderPath: projectSkill }],
    },
  };
}
