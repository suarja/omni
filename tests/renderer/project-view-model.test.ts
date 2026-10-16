import { describe, expect, it } from "vitest";
import { t } from "../../src/renderer/i18n";
import { buildProjectGraph } from "../../src/renderer/canvas/project-graph-layout";
import {
  filterProjectSkills,
  maintenanceIntent,
  projectInstructions,
  projectInventory,
} from "../../src/renderer/canvas/project-view-model";
import { projectAssignmentChoices } from "../../src/renderer/canvas/ProjectAddSkillsSheet";
import { projectApi, projectId, projectSnapshot, skillRow, skills } from "./project-view-fixture";
import type { ResourceCanvasProps } from "../../src/renderer/canvas/resource-canvas-types";
import type { AssignmentArtifactChoice } from "../../src/renderer/canvas/changes/AssignmentTargets";

describe("project view evidence", () => {
  it("keeps disabled skills out of active origin filters", () => {
    expect(filterProjectSkills(skills.skills, "active", "").map((row) => row.id)).toEqual([
      "review",
      "grill-me",
      "local-tool",
    ]);
    expect(filterProjectSkills(skills.skills, "disabled", "").map((row) => row.id)).toEqual(["parked"]);
    expect(filterProjectSkills(skills.skills, "mine", "REVIEW").map((row) => row.id)).toEqual(["review"]);
    expect(filterProjectSkills(skills.skills, "external", "mattpocock").map((row) => row.id)).toEqual(["grill-me"]);
  });
  it("preserves separate external sources as headings above non-overlapping logical skills", () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({
      ...skillRow(`external-${i}`, "external"),
      origin: { kind: "external" as const, source: i < 9 ? "source-a" : "source-b" },
    }));
    const model = buildProjectGraph({ ...skills, skills: rows }, "Project", "external", [], t);
    expect(model.headings.map((h) => h.title)).toEqual(["source-a · 9", "source-b · 4"]);
    expect(model.nodes).toHaveLength(13);
    for (const a of model.nodes)
      for (const b of model.nodes)
        if (a.id !== b.id) expect(Math.abs(a.x - b.x) >= 264 || Math.abs(a.y - b.y) >= 96).toBe(true);
  });
  it("shows update and one-sided counts as exception chips on origin nodes", () => {
    const model = buildProjectGraph(skills, "Project", null, [], t);
    expect(model.nodes.find((node) => node.id === "mine")?.badge).toEqual({ kind: "update", label: "1 update" });
    expect(model.nodes.find((node) => node.id === "project-only")?.badge).toEqual({
      kind: "modified",
      label: "1 on one side only",
    });
  });
  it("starts group skills at the top-left grid with four columns and singular counts", () => {
    const rows = Array.from({ length: 5 }, (_, i) => skillRow(`owned-${i}`));
    const model = buildProjectGraph({ ...skills, skills: rows }, "Project", "mine", [], t);
    expect(model.nodes.map(({ x, y }) => [x - 132, y - 36])).toEqual([
      [40, 70],
      [324, 70],
      [608, 70],
      [892, 70],
      [40, 166],
    ]);
    const overview = buildProjectGraph({ ...skills, skills: [rows[0]!] }, "Project", null, [], t);
    expect(overview.nodes.find((node) => node.id === "mine")?.meta).toBe("1 skill");
    expect(overview.nodes.find((node) => node.id === "external")?.meta).toBe("0 skills · 0 sources");
  });
  it("names a shared instruction by its actual target and keeps independent files separate", () => {
    const inventory = projectInventory(projectSnapshot, projectId)!;
    expect(projectInstructions(inventory)[0]).toMatchObject({ path: "CLAUDE.md", aliases: ["AGENTS.md", "GEMINI.md"] });
    const standalone = {
      ...inventory.artifacts.at(-1)!,
      id: "separate",
      physicalIdentity: "docs/AGENTS.md",
      relativePath: "docs/AGENTS.md",
      projectionPaths: ["docs/AGENTS.md"],
    };
    expect(
      projectInstructions({ ...inventory, artifacts: [...inventory.artifacts, standalone] }).map((file) => file.path),
    ).toEqual(["CLAUDE.md", "docs/AGENTS.md"]);
  });
  it("updates only the selected project's exact installed copies through S05", () => {
    expect(maintenanceIntent(projectId, skills.skills[0]!)).toEqual({
      kind: "maintain-current",
      source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
      locations: [
        { projectId, harnessId: "claude-code", folderPath: ".claude/skills/review" },
        { projectId, harnessId: "codex", folderPath: ".agents/skills/review" },
      ],
    });
    expect(maintenanceIntent(projectId, skills.skills[1]!)).toBeUndefined();
  });
  it("offers only missing personal marketplace skills with package-relative assignment paths", () => {
    const canvas: ResourceCanvasProps = {
      context: { kind: "entry", entry: { kind: "project", id: projectId } },
      snapshot: projectSnapshot,
      api: projectApi(),
      onEnsureGrant: async () => "grant",
      onRefresh: () => {},
      onNavigate: () => {},
      onNavigateDestination: () => {},
    };
    const artifacts: AssignmentArtifactChoice[] = [
      {
        sourceId: "source-one",
        packageId: "pstack",
        artifactPath: "plugins/pstack/skills/review/SKILL.md",
        name: "review",
      },
      {
        sourceId: "source-one",
        packageId: "other",
        artifactPath: "plugins/other/skills/review/SKILL.md",
        name: "Another review",
      },
      { sourceId: "external", packageId: "other", artifactPath: "skills/new/SKILL.md", name: "Not personal" },
    ];
    expect(projectAssignmentChoices(canvas, artifacts, skills)).toEqual([
      { ...artifacts[1], artifactPath: "skills/review" },
    ]);
  });
});
