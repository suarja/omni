import { expect, it } from "vitest";
import { readObservedProjectSkills } from "../../src/renderer/canvas/rail/observed-project-skills";
import { addWorkspaceUseRelations } from "../../src/renderer/canvas/rail/workspace-relations";
import type { ManagedSkillUse } from "../../src/domain/skill-reconciliation/types";
import { projectSnapshot, projectId } from "./project-view-fixture";
import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import { projectCanvas } from "../../src/renderer/canvas/spatial/canvas-projection";

const managed: ManagedSkillUse = {
  skillId: "11111111-1111-4111-8111-111111111111",
  bindingId: "managed-1",
  source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
  location: { projectId, harnessId: "codex", folderPath: ".agents/skills/review" },
  baseRevisionId: "22222222-2222-4222-8222-222222222222",
};

it("keeps disabled managed copies out of recommendations to install a missing agent", () => {
  const observed = {
    ...projectSnapshot,
    roots: projectSnapshot.roots.map((root) =>
      root.entry.id === projectId && root.evidence.status === "observed"
        ? {
            ...root,
            evidence: {
              status: "observed" as const,
              observation: {
                ...root.evidence.observation,
                inventory: {
                  ...root.evidence.observation.inventory,
                  artifacts: root.evidence.observation.inventory.artifacts.map((artifact) => ({
                    ...artifact,
                    scope: "project" as const,
                  })),
                },
              },
            },
          }
        : root,
    ),
  };
  const rows = readObservedProjectSkills(observed, [{ ...managed, disabled: true }]);
  expect(rows.find((row) => row.projectId === projectId)?.skills[0]?.agents.codex.state).toBe("disabled");
});

it("does not infer absent agent copies from an incomplete project inventory", () => {
  const snapshot = {
    ...projectSnapshot,
    roots: projectSnapshot.roots.map((root) =>
      root.entry.id === projectId && root.evidence.status === "observed"
        ? {
            ...root,
            evidence: {
              status: "observed" as const,
              observation: {
                ...root.evidence.observation,
                inventory: {
                  ...root.evidence.observation.inventory,
                  diagnostics: [
                    {
                      location: ".agents/skills",
                      code: "inaccessible" as const,
                      severity: "warning" as const,
                      message: "Unreadable directory",
                    },
                  ],
                },
              },
            },
          }
        : root,
    ),
  };
  expect(readObservedProjectSkills(snapshot, []).flatMap((row) => row.skills)).toHaveLength(0);
});

it("deduplicates marketplace wires and excludes archived or unregistered relationships", () => {
  const catalogue = createResourceCatalogue(projectSnapshot);
  const projection = projectCanvas(catalogue.browse({ kind: "workspace" }), catalogue, null);
  const valid = { ...managed, location: { ...managed.location, projectId: "project-two" } };
  const result = addWorkspaceUseRelations(projection, projectSnapshot, [
    valid,
    { ...valid, bindingId: "other" },
    { ...valid, source: { ...valid.source, sourceId: "absent" } },
  ]);
  expect(result.relations).toHaveLength(projection.relations.length + 1);
  const archived = {
    ...projectSnapshot,
    registry: {
      ...projectSnapshot.registry,
      projects: projectSnapshot.registry.projects.map((project) =>
        project.ref.id === "project-two" ? { ...project, archivedAt: "2026-10-11T00:00:00Z" } : project,
      ),
    },
  };
  expect(addWorkspaceUseRelations(projection, archived, [valid]).relations).toHaveLength(projection.relations.length);
});
