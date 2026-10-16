import { vi } from "vitest";
import type { ProjectSkillRow, ProjectSkills } from "../../src/shared/project-skills-ipc";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";
import { resourceFixture, snapshot } from "../fixtures/resource-catalogue";

export const projectId = resourceFixture.projectOneRef.id;
export function skillRow(id: string, kind: ProjectSkillRow["origin"]["kind"] = "mine"): ProjectSkillRow {
  return {
    id,
    skillId: "11111111-1111-4111-8111-111111111111",
    name: id,
    description: `Description of ${id}`,
    origin:
      kind === "mine"
        ? { kind, sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review", label: "pstack" }
        : kind === "external"
          ? { kind, source: "mattpocock/skills" }
          : { kind },
    agents: { "claude-code": { state: "installed", folderPath: `.claude/skills/${id}` }, codex: { state: "absent" } },
    state: "current",
  };
}
export const skills: ProjectSkills = {
  projectId,
  skills: [
    {
      ...skillRow("review"),
      state: "update-available",
      agents: {
        "claude-code": { state: "installed", folderPath: ".claude/skills/review", symlink: true },
        codex: { state: "installed", folderPath: ".agents/skills/review" },
      },
    },
    skillRow("grill-me", "external"),
    skillRow("local-tool", "project-only"),
    { ...skillRow("parked"), agents: { "claude-code": { state: "disabled" }, codex: { state: "disabled" } } },
  ],
  activeSkillCount: { "claude-code": 3, codex: 1 },
  startupCost: { "claude-code": 120, codex: 40 },
  diagnostics: [
    {
      location: ".agents/skills/unreadable",
      code: "inaccessible",
      severity: "warning",
      message: "Permission denied while reading skill",
    },
  ],
};
export const projectSnapshot: ResourceSnapshot = {
  ...snapshot,
  roots: snapshot.roots.map((root) =>
    root.entry.id !== projectId || root.evidence.status !== "observed"
      ? root
      : {
          ...root,
          evidence: {
            status: "observed",
            observation: {
              ...root.evidence.observation,
              inventory: {
                ...root.evidence.observation.inventory,
                harnesses: ["claude-code", "codex"],
                artifacts: [
                  ...root.evidence.observation.inventory.artifacts,
                  {
                    id: "instructions",
                    physicalIdentity: "CLAUDE.md",
                    projectionPaths: ["CLAUDE.md", "AGENTS.md", "GEMINI.md"],
                    relativePath: "AGENTS.md",
                    displayPath: "AGENTS.md",
                    kind: "instruction",
                    providerIds: ["claude-code", "codex", "gemini"],
                    scope: "project",
                    confidence: "exact",
                    symlinkState: "inside-root",
                  },
                ],
              },
            },
          },
        },
  ),
};
export function projectApi() {
  return {
    readProjectSkills: vi.fn(async (id: string) => ({ ...structuredClone(skills), projectId: id })),
    readArtifact: vi.fn(async () => ({
      status: "read" as const,
      content: "# Actual content",
      byteLength: 16,
      truncated: false,
    })),
    previewSkillOperation: vi.fn(async () => ({
      status: "ready" as const,
      intentId: "intent-1",
      planId: "plan-1",
      effectFingerprint: "fingerprint-1",
      scope: { targets: [] },
      steps: [],
    })),
    refreshSkillOperation: vi.fn(),
    applySkillOperation: vi.fn(async () => ({
      intentId: "intent-1",
      operationId: "operation-1",
      status: "applied" as const,
      source: { status: "unchanged" as const },
      targets: [],
      receiptIds: ["receipt-1"],
      issues: [],
      recoveryAvailable: false,
    })),
    readSkillOperationResult: vi.fn(),
    observeSkillCopies: vi.fn(),
    compareSkillCopies: vi.fn(),
    readSkillVariantOrigin: vi.fn(),
  };
}
