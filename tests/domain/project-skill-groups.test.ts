import { describe, expect, it } from "vitest";

import { createProjectSkillGroups } from "../../src/domain/resource-catalogue/project-skill-groups";
import type { Binding } from "../../src/domain/assignment-plan";
import type { ObservedPackageFormat } from "../../src/domain/inventory";
import type { ProjectSkillGroup } from "../../src/domain/resource-catalogue";
import type { SkillOriginEvidence } from "../../src/domain/skill-origins/types";

const projectId = "project-one";
const reviewPath = ".claude/skills/review/SKILL.md";
const projectRef = { kind: "project", id: projectId } as const;
const artifactRef = { kind: "artifact", entry: projectRef, artifactId: "project-review" } as const;
const sourceRef = { kind: "source", id: "source-one" } as const;

function origin(locator: string, relativePath = reviewPath): SkillOriginEvidence {
  return {
    artifactId: artifactRef.artifactId,
    relativePath,
    source: { kind: "github", locator },
    lockPath: "skills-lock.json",
    recordedHash: "a".repeat(64),
    verification: "matches-lock",
  };
}

function binding(overrides: Partial<Binding> = {}): Binding {
  return {
    bindingId: "binding-one",
    sourceId: sourceRef.id,
    packageId: "pstack",
    artifactPath: "skills/review",
    kind: "skill",
    projectId,
    harnessId: "claude-code",
    boundHash: "b".repeat(64),
    createdAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  };
}

function pkg(
  sourceId: string,
  packageId: string,
  skillPaths: readonly string[] = ["skills/review/SKILL.md"],
  format: ObservedPackageFormat = "claude-plugin",
) {
  return {
    ref: { kind: "package" as const, entry: { kind: "source" as const, id: sourceId }, packageId },
    label: packageId,
    relativeRoot: `plugins/${packageId}`,
    format,
    skillPaths,
  };
}

function resolve(
  input: {
    locations?: readonly ProjectSkillGroup["locations"][number][];
    bindings?: Parameters<typeof createProjectSkillGroups>[0]["bindings"];
    packages?: Parameters<typeof createProjectSkillGroups>[0]["packages"];
  } = {},
): readonly ProjectSkillGroup[] {
  return createProjectSkillGroups({
    projectId,
    locations: input.locations ?? [{ ref: artifactRef, relativePath: reviewPath }],
    bindings: input.bindings ?? { status: "ready", bindings: [] },
    packages: input.packages ?? [],
  });
}

describe("project skill groups", () => {
  it("preserves each exact project path while collapsing repeated bindings for one package", () => {
    const secondPath = ".agents/skills/review/SKILL.md";
    const groups = resolve({
      locations: [
        { ref: artifactRef, relativePath: reviewPath },
        { ref: artifactRef, relativePath: secondPath },
      ],
      bindings: {
        status: "ready",
        bindings: [binding(), binding({ bindingId: "binding-two", harnessId: "codex" })],
      },
      packages: [pkg(sourceRef.id, "pstack", ["skills/review/SKILL.md", "skills/other/SKILL.md"], "agent-plugin")],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: JSON.stringify(["managed", sourceRef.id, "pstack"]),
      category: "managed-plugin",
      label: "pstack",
      sourcePackage: pkg(sourceRef.id, "pstack").ref,
    });
    expect(groups[0]?.locations.map((location) => location.relativePath)).toEqual([secondPath, reviewPath]);
  });

  it("keeps a location individual when multiple observed packages claim the same target", () => {
    const groups = resolve({
      bindings: {
        status: "ready",
        bindings: [
          binding(),
          binding({ bindingId: "binding-other", sourceId: "source-two", packageId: "pstack-copy" }),
        ],
      },
      packages: [pkg(sourceRef.id, "pstack"), pkg("source-two", "pstack-copy")],
    });

    expect(groups).toMatchObject([
      {
        id: "individual-skills",
        category: "individual",
        locations: [{ relativePath: reviewPath, membershipIssue: "ambiguous-assignment" }],
      },
    ]);
  });

  it("keeps separate packages from one source repository in separate groups", () => {
    const secondPath = ".agents/skills/review/SKILL.md";
    const groups = resolve({
      locations: [
        { ref: artifactRef, relativePath: reviewPath },
        { ref: { ...artifactRef, artifactId: "project-review-codex" }, relativePath: secondPath },
      ],
      bindings: {
        status: "ready",
        bindings: [binding(), binding({ bindingId: "binding-codex", packageId: "other-package", harnessId: "codex" })],
      },
      packages: [pkg(sourceRef.id, "pstack"), pkg(sourceRef.id, "other-package")],
    });

    expect(groups.map((group) => group.id)).toEqual([
      JSON.stringify(["managed", sourceRef.id, "other-package"]),
      JSON.stringify(["managed", sourceRef.id, "pstack"]),
    ]);
    expect(groups.every((group) => group.category === "managed-plugin")).toBe(true);
  });

  it("does not turn unavailable bindings into managed groups", () => {
    const groups = resolve({
      bindings: { status: "unavailable" },
      packages: [pkg(sourceRef.id, "pstack")],
    });

    expect(groups).toMatchObject([{ category: "individual", locations: [{ relativePath: reviewPath }] }]);
  });

  it("reports unavailable observed source membership without inventing a package", () => {
    const groups = resolve({ bindings: { status: "ready", bindings: [binding()] } });

    expect(groups).toMatchObject([
      {
        category: "individual",
        locations: [{ relativePath: reviewPath, membershipIssue: "source-unavailable" }],
      },
    ]);
  });

  it("requires the exact source skill path and exact resolved project target", () => {
    const missingSourceChild = resolve({
      bindings: { status: "ready", bindings: [binding()] },
      packages: [pkg(sourceRef.id, "pstack", ["skills/other/SKILL.md"])],
    });
    const differentTarget = resolve({
      locations: [{ ref: artifactRef, relativePath: ".claude/skills/another/SKILL.md" }],
      bindings: { status: "ready", bindings: [binding()] },
      packages: [pkg(sourceRef.id, "pstack")],
    });

    expect(missingSourceChild[0]?.locations[0]?.membershipIssue).toBe("source-unavailable");
    expect(differentTarget[0]?.locations[0]).toMatchObject({ relativePath: ".claude/skills/another/SKILL.md" });
    expect(differentTarget[0]?.locations[0]?.membershipIssue).toBeUndefined();
  });

  it("rejects absolute source paths instead of normalizing them into package-relative paths", () => {
    const groups = resolve({
      bindings: { status: "ready", bindings: [binding({ artifactPath: "/skills/review" })] },
      packages: [pkg(sourceRef.id, "pstack")],
    });

    expect(groups).toMatchObject([{ category: "individual", locations: [{ relativePath: reviewPath }] }]);
    expect(groups[0]?.locations[0]?.membershipIssue).toBeUndefined();
  });

  it("groups origin locations by normalized repository without merging distinct repositories", () => {
    const secondRef = { ...artifactRef, artifactId: "project-other" };
    const pathA = ".claude/skills/alpha/SKILL.md";
    const pathB = ".claude/skills/beta/SKILL.md";
    const groups = resolve({
      locations: [
        { ref: artifactRef, relativePath: pathA, origin: origin("Owner/Repo", pathA) },
        { ref: secondRef, relativePath: pathB, origin: origin("owner/repo", pathB) },
        {
          ref: secondRef,
          relativePath: ".claude/skills/gamma/SKILL.md",
          origin: origin("other/repo", ".claude/skills/gamma/SKILL.md"),
        },
      ],
    });

    expect(groups.map((group) => group.id)).toEqual([
      JSON.stringify(["origin", "github", "other/repo"]),
      JSON.stringify(["origin", "github", "owner/repo"]),
    ]);
    expect(groups[1]?.locations).toHaveLength(2);
  });

  it("retains modified and unverified origin evidence without changing its declared attribution", () => {
    const modifiedPath = ".claude/skills/modified/SKILL.md";
    const unverifiedPath = ".agents/skills/unverified/SKILL.md";
    const modifiedOrigin = { ...origin("owner/repo", modifiedPath), verification: "modified" as const };
    const unverifiedOrigin = {
      ...origin("owner/repo", unverifiedPath),
      verification: "unverified" as const,
      verificationReason: "budget" as const,
    };
    const groups = resolve({
      locations: [
        { ref: artifactRef, relativePath: modifiedPath, origin: modifiedOrigin },
        {
          ref: { ...artifactRef, artifactId: "project-unverified" },
          relativePath: unverifiedPath,
          origin: unverifiedOrigin,
        },
      ],
    });

    expect(groups).toMatchObject([
      {
        category: "origin",
        source: { kind: "github", locator: "owner/repo" },
        locations: [
          { origin: { verification: "modified" } },
          { origin: { verification: "unverified", verificationReason: "budget" } },
        ],
      },
    ]);
  });

  it("keeps explicit managed membership and discloses a conflicting declared origin", () => {
    const groups = resolve({
      locations: [{ ref: artifactRef, relativePath: reviewPath, origin: origin("other/repo") }],
      bindings: { status: "ready", bindings: [binding()] },
      packages: [pkg(sourceRef.id, "pstack")],
    });

    expect(groups[0]).toMatchObject({
      category: "managed-plugin",
      locations: [{ origin: { source: { locator: "other/repo" } }, membershipIssue: "assignment-origin-disagreement" }],
    });
  });

  it("deduplicates only identical resource and path locations", () => {
    const groups = resolve({
      locations: [
        { ref: artifactRef, relativePath: reviewPath },
        { ref: artifactRef, relativePath: reviewPath },
        { ref: artifactRef, relativePath: ".agents/skills/review/SKILL.md" },
      ],
    });

    expect(groups[0]?.locations.map((location) => location.relativePath)).toEqual([
      ".agents/skills/review/SKILL.md",
      reviewPath,
    ]);
  });
});
