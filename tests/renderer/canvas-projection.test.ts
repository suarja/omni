import { describe, expect, it } from "vitest";

import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import { projectCanvas } from "../../src/renderer/canvas/spatial/canvas-projection";
import { resourceNodeId } from "../../src/renderer/canvas/spatial/spatial-types";
import { correlateSkillCopies } from "../../src/domain/skill-reconciliation/correlation";
import type { SkillCorrelation, SkillMember } from "../../src/domain/skill-reconciliation/types";
import { denseSnapshot, projectSnapshot } from "../fixtures/spatial-canvas";
import { resourceFixture } from "../fixtures/resource-catalogue";

const context = { kind: "entry", entry: resourceFixture.projectOneRef } as const;

describe("dense project presentation", () => {
  it("projects two exact physical locations as one logical skill node and keeps the project group ID", () => {
    const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
    const artifacts = [".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"].map((path, index) => ({
      ...template,
      id: `review-copy-${index}`,
      packageId: undefined,
      relativePath: path,
      displayPath: path,
      physicalIdentity: path,
      projectionPaths: [path],
    }));
    const catalogue = createResourceCatalogue(projectSnapshot(artifacts));
    const group = catalogue.projectSkillGroups(resourceFixture.projectOneRef)[0]!;
    const revision = {
      algorithm: "omni-tree-v1" as const,
      hash: "a".repeat(64),
      files: [{ path: "SKILL.md", hash: "a".repeat(64), byteLength: 1 }],
    };
    const members: SkillMember[] = group.locations.map((location) => ({
      location: {
        projectId: resourceFixture.projectOneRef.id,
        harnessId: location.relativePath.startsWith(".claude/") ? "claude-code" : "codex",
        folderPath: location.relativePath.replace(/\/SKILL\.md$/u, ""),
      },
      ref: location.ref,
      read: { status: "complete", revision },
    }));
    const correlation = correlateSkillCopies({
      projectId: resourceFixture.projectOneRef.id,
      members,
      records: [],
      allocateId: () => "logical-review",
    });
    const overview = projectCanvas(catalogue.browse(context), catalogue, null, new Map([[group.id, correlation]]));
    const projected = overview.groups.find((candidate) => candidate.id === group.id);

    expect(projected?.children).toHaveLength(1);
    expect(projected?.children[0]).toMatchObject({
      kind: "logical-skill",
      skillId: "logical-review",
      groupId: group.id,
    });
    expect(projected?.children[0]?.kind === "logical-skill" ? projected.children[0].members : []).toHaveLength(2);
  });

  it("groups 39 observed skill locations without changing catalogue identities", () => {
    const catalogue = createResourceCatalogue(denseSnapshot());
    const before = catalogue.search("");
    const overview = projectCanvas(catalogue.browse(context), catalogue, null);

    expect(overview.children).toHaveLength(1);
    expect(overview.groups[0]?.id).toBe("individual-skills");
    expect(overview.groups[0]?.children).toHaveLength(39);
    expect(catalogue.search("")).toEqual(before);
  });

  it("keeps same-label resources and two observed locations distinct", () => {
    const shared = {
      ...resourceFixture.projectObservation.inventory.artifacts[0]!,
      id: "shared-copy",
      relativePath: ".agents/skills/review/SKILL.md",
      physicalIdentity: "physical/review",
      projectionPaths: [".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"],
    };
    const unrelated = {
      ...shared,
      id: "other-review",
      relativePath: ".claude/skills/review/SKILL.md",
      physicalIdentity: "physical/other-review",
      projectionPaths: [".claude/skills/review/SKILL.md"],
    };
    const catalogue = createResourceCatalogue({
      ...projectSnapshot([shared, unrelated]),
      uses: { status: "ready", bindings: [] },
    });
    const overview = projectCanvas(catalogue.browse(context), catalogue, null);
    const locations = overview.groups.flatMap((group) => group.children);

    expect(locations).toHaveLength(3);
    expect(new Set(locations.map((node) => node.id)).size).toBe(3);
    expect(locations.filter((node) => node.kind === "resource" && node.resource.label === "review")).toHaveLength(3);
    expect(overview.groups.map((group) => group.id)).toEqual(["individual-skills"]);
    expect(
      locations.map((node) =>
        node.kind === "resource" ? resourceNodeId(node.resource.ref, node.relativePath) : node.id,
      ),
    ).toEqual(locations.map((node) => node.id));
  });

  it("keeps package-owned resources in the observed package", () => {
    const artifact = {
      ...resourceFixture.projectObservation.inventory.artifacts[0]!,
      id: "owned-skill",
      packageId: "real-package",
      relativePath: ".agents/skills/owned/SKILL.md",
      physicalIdentity: "owned-skill",
      projectionPaths: [".agents/skills/owned/SKILL.md"],
    };
    const pkg = {
      id: "real-package",
      relativeRoot: "plugins/real",
      displayName: "Real package",
      format: "implicit" as const,
      manifestPaths: [],
      artifactIds: [artifact.id],
    };
    const catalogue = createResourceCatalogue(projectSnapshot([artifact], [pkg]));
    const overview = projectCanvas(catalogue.browse(context), catalogue, null);

    expect(overview.children.map((node) => (node.kind === "resource" ? node.resource.kind : node.kind))).toEqual([
      "plugin",
    ]);
    expect(overview.groups).toEqual([]);
    const packageListing = catalogue.browse({
      kind: "package",
      entry: resourceFixture.projectOneRef,
      packageId: pkg.id,
    });
    expect(projectCanvas(packageListing, catalogue, null).children[0]).toMatchObject({
      kind: "resource",
      resource: { label: "owned" },
    });
  });

  it("omits an exact support peer while keeping that file in the skill reader", () => {
    const skill = resourceFixture.projectObservation.inventory.artifacts[0]!;
    const support = {
      ...skill,
      id: "support-note",
      kind: "unknown" as const,
      relativePath: ".claude/skills/review/references/note.md",
      displayPath: ".claude/skills/review/references/note.md",
      physicalIdentity: "support-note",
      projectionPaths: [".claude/skills/review/references/note.md"],
    };
    const catalogue = createResourceCatalogue(projectSnapshot([skill, support]));
    const overview = projectCanvas(catalogue.browse(context), catalogue, null);
    const group = overview.groups.find((item) => item.id === JSON.stringify(["managed", "source-one", "pstack"]));
    const skillNode = group?.children[0];

    expect(overview.groups.find((item) => item.id === "other")).toBeUndefined();
    expect(skillNode?.kind).toBe("resource");
    if (skillNode?.kind !== "resource") return;
    expect(catalogue.inspect(skillNode.resource.ref)?.files).toContainEqual({
      relativePath: support.relativePath,
      role: "support",
    });
  });

  it("keeps unknown loose resources reachable and unavailable entries empty", () => {
    const artifact = {
      ...resourceFixture.projectObservation.inventory.artifacts[0]!,
      id: "unknown-config",
      kind: "unknown" as const,
      relativePath: ".vscode/settings.json",
      displayPath: ".vscode/settings.json",
      physicalIdentity: "unknown-config",
      projectionPaths: [".vscode/settings.json"],
    };
    const available = createResourceCatalogue(projectSnapshot([artifact]));
    expect(
      projectCanvas(available.browse(context), available, null).groups.find((item) => item.id === "other")?.children,
    ).toHaveLength(1);

    const unavailableSnapshot = {
      ...denseSnapshot(),
      roots: denseSnapshot().roots.map((root) =>
        root.entry.kind === "project" && root.entry.id === resourceFixture.projectOneRef.id
          ? { ...root, evidence: { status: "unavailable" as const, reason: "inaccessible" as const } }
          : root,
      ),
    };
    const unavailable = createResourceCatalogue(unavailableSnapshot);
    const projection = projectCanvas(unavailable.browse(context), unavailable, null);
    expect(projection.children).toEqual([]);
    expect(projection.groups).toEqual([]);
  });

  it("uses current observations on refresh and falls back when a group disappears", () => {
    const first = createResourceCatalogue(denseSnapshot());
    const saved = projectCanvas(first.browse(context), first, null);
    const removed = createResourceCatalogue(projectSnapshot([]));
    const projection = projectCanvas(removed.browse(context), removed, "individual-skills");

    expect(projection.groups).toEqual([]);
    expect(projection.center?.kind).toBe("resource");
    expect(saved.children).toHaveLength(1);
    expect(first.search("")).not.toEqual(removed.search(""));
  });

  it("anchors one persisted skill spanning managed and individual groups under its observed managed source", () => {
    const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
    const artifacts = [".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"].map((path, index) => ({
      ...template,
      id: `mixed-copy-${index}`,
      packageId: undefined,
      relativePath: path,
      displayPath: path,
      physicalIdentity: path,
      projectionPaths: [path],
    }));
    const catalogue = createResourceCatalogue({
      ...projectSnapshot(artifacts),
      uses: { status: "ready", bindings: [resourceFixture.bindings[0]!] },
    });
    const groups = catalogue.projectSkillGroups(resourceFixture.projectOneRef);
    const managed = groups.find((group) => group.category === "managed-plugin");
    const individual = groups.find((group) => group.category === "individual");
    if (!managed || !individual) throw new Error("The mixed copy fixture must split managed and individual locations.");
    const skillId = "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18";
    const record = {
      skillId,
      label: "review",
      evidence: "observed-equivalence" as const,
      locations: groups.flatMap((group) =>
        group.locations.map((location) => ({
          projectId: resourceFixture.projectOneRef.id,
          harnessId: location.relativePath.startsWith(".claude/") ? ("claude-code" as const) : ("codex" as const),
          folderPath: location.relativePath.replace(/\/SKILL\.md$/u, ""),
        })),
      ),
    };
    const correlations = new Map<string, SkillCorrelation>();
    for (const group of [managed, individual]) {
      const location = group.locations[0]!;
      const skillLocation = record.locations.find(
        (candidate) => candidate.folderPath === location.relativePath.replace(/\/SKILL\.md$/u, ""),
      )!;
      const hash = skillLocation.harnessId === "codex" ? "a" : "b";
      const revision = { algorithm: "omni-tree-v1" as const, hash: hash.repeat(64), files: [] };
      const read = { status: "complete" as const, revision };
      const member: SkillMember = { location: skillLocation, ref: location.ref, read };
      correlations.set(group.id, {
        records: [record],
        groups: [
          { skillId, members: [member], locations: [{ location: skillLocation, read }], state: "matching-copies" },
        ],
        candidates: [],
      });
    }
    const projection = projectCanvas(catalogue.browse(context), catalogue, null, correlations);
    const nodes = projection.groups.flatMap((group) =>
      group.children.filter((child) => child.kind === "logical-skill" && child.skillId === skillId),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "logical-skill",
      groupId: managed.id,
      attention: { state: "copy-difference", reasons: ["copy-difference"] },
    });
    expect(
      nodes[0]?.kind === "logical-skill" ? nodes[0].members.map(({ location }) => location.folderPath).sort() : [],
    ).toEqual([".agents/skills/review", ".claude/skills/review"]);
  });

  it("falls back to the unique declared-origin group when no managed source group is observed", () => {
    const template = resourceFixture.projectObservation.inventory.artifacts[0]!;
    const artifacts = [".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"].map((path, index) => ({
      ...template,
      id: `origin-copy-${index}`,
      packageId: undefined,
      relativePath: path,
      displayPath: path,
      physicalIdentity: path,
      projectionPaths: [path],
    }));
    const base = projectSnapshot(artifacts);
    const roots = base.roots.map((root) => {
      if (root.entry.kind !== "project" || root.entry.id !== resourceFixture.projectOneRef.id) return root;
      if (root.evidence.status !== "observed") return root;
      return {
        ...root,
        evidence: {
          status: "observed" as const,
          observation: {
            ...root.evidence.observation,
            inventory: {
              ...root.evidence.observation.inventory,
              skillOrigins: [
                {
                  artifactId: "origin-copy-0",
                  relativePath: ".agents/skills/review/SKILL.md",
                  source: { kind: "github" as const, locator: "microsoft/skills" },
                  skillKey: "review",
                  lockPath: "skills-lock.json" as const,
                  recordedHash: "f".repeat(64),
                  verification: "matches-lock" as const,
                },
              ],
            },
          },
        },
      };
    });
    const catalogue = createResourceCatalogue({ ...base, roots, uses: { status: "ready", bindings: [] } });
    const groups = catalogue.projectSkillGroups(resourceFixture.projectOneRef);
    const origin = groups.find((group) => group.category === "origin");
    const individual = groups.find((group) => group.category === "individual");
    if (!origin || !individual)
      throw new Error("The declared origin fixture must split its location from individual skills.");
    const skillId = "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18";
    const record = {
      skillId,
      label: "review",
      evidence: "declared" as const,
      declaration: { locator: "microsoft/skills", skillKey: "review" },
      locations: groups.flatMap((group) =>
        group.locations.map((location) => ({
          projectId: resourceFixture.projectOneRef.id,
          harnessId: location.relativePath.startsWith(".claude/") ? ("claude-code" as const) : ("codex" as const),
          folderPath: location.relativePath.replace(/\/SKILL\.md$/u, ""),
        })),
      ),
    };
    const revision = { algorithm: "omni-tree-v1" as const, hash: "a".repeat(64), files: [] };
    const correlations = new Map<string, SkillCorrelation>(
      [origin, individual].map((group) => {
        const location = group.locations[0]!;
        const skillLocation = record.locations.find(
          (candidate) => candidate.folderPath === location.relativePath.replace(/\/SKILL\.md$/u, ""),
        )!;
        const read = { status: "complete" as const, revision };
        return [
          group.id,
          {
            records: [record],
            groups: [
              {
                skillId,
                members: [{ location: skillLocation, ref: location.ref, read }],
                locations: [{ location: skillLocation, read }],
                state: "matching-copies",
              },
            ],
            candidates: [],
          },
        ];
      }),
    );
    const projection = projectCanvas(catalogue.browse(context), catalogue, null, correlations);
    const nodes = projection.groups.flatMap((group) =>
      group.children.filter((child) => child.kind === "logical-skill" && child.skillId === skillId),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "logical-skill", groupId: origin.id });
  });
});
