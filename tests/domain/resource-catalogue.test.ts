import { describe, expect, it } from "vitest";

import { createResourceCatalogue } from "../../src/domain/resource-catalogue";
import type { SkillOriginEvidence } from "../../src/domain/skill-origins/types";
import { otherSkillRef, skillRef, snapshot, sourceRefResource, resourceFixture } from "../fixtures/resource-catalogue";

describe("resource catalogue", () => {
  it("preserves qualified skill identities and only aggregates explicit desired uses", () => {
    const catalogue = createResourceCatalogue(snapshot);
    expect(catalogue.inspect(skillRef)?.resource.ref).toEqual(skillRef);
    expect(catalogue.inspect(otherSkillRef)?.resource.ref).toEqual(otherSkillRef);
    expect(
      catalogue.browse({ kind: "workspace" }).relations.filter((relation) => relation.kind === "desired-use"),
    ).toHaveLength(1);
    expect(catalogue.inspect(skillRef)?.uses.status).toBe("ready");
    expect(catalogue.browse(sourceRefResource).children.filter((resource) => resource.kind === "plugin")).toHaveLength(
      2,
    );
  });

  it("groups observed support files, hides manifests and matches package-relative bindings", () => {
    const catalogue = createResourceCatalogue(snapshot);
    const source = catalogue.browse(sourceRefResource);
    expect(source.children.map((resource) => resource.label)).toEqual(["Other", "pstack"]);
    const packageRef = source.children.find((resource) => resource.label === "pstack")?.ref;
    expect(packageRef).toBeDefined();
    const packageListing = catalogue.browse(packageRef!);
    expect(packageListing.children.filter((resource) => resource.kind === "artifact")).toHaveLength(2);
    expect(packageListing.children.some((resource) => resource.label.includes("plugin.json"))).toBe(false);
    expect(catalogue.inspect(skillRef)?.files).toEqual(
      [
        { relativePath: "plugins/pstack/skills/review/SKILL.md", role: "content" },
        { relativePath: "plugins/pstack/skills/review/references/note.md", role: "support" },
      ].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    );
    expect(catalogue.inspect(skillRef)?.uses).toMatchObject({
      status: "ready",
      bindings: [{ bindingId: "binding-one" }, { bindingId: "binding-two" }],
    });
  });

  it("keeps unknown evidence distinct, sorts search, and never exposes private root or grant data", () => {
    const catalogue = createResourceCatalogue(snapshot);
    expect(catalogue.browse({ kind: "workspace" }).status).toBe("partial");
    expect(catalogue.search(" REVIEW ").map((resource) => resource.ref)).toEqual([
      { kind: "artifact", entry: { kind: "project", id: "project-one" }, artifactId: "project-skill" },
      otherSkillRef,
      skillRef,
    ]);
    expect(JSON.stringify([catalogue.browse({ kind: "workspace" }), catalogue.search("")])).not.toContain(
      "secret-grant-handle",
    );
    expect(JSON.stringify(catalogue.search("")).toLowerCase()).not.toContain("private-root");
  });

  it("keeps every observed package support file available after grouping nodes", () => {
    const catalogue = createResourceCatalogue(snapshot);
    const packageRef = catalogue.browse(sourceRefResource).children.find((record) => record.label === "pstack")!.ref;
    const files = catalogue.inspect(packageRef)!.files.map((file) => file.relativePath);
    expect(files).toContain("plugins/pstack/skills/review/references/note.md");
    expect(new Set(files).size).toBe(files.length);
  });

  it("exposes physical projection paths without duplicating the skill node", () => {
    const observation = resourceFixture.sourceObservation;
    const projected = {
      ...observation,
      inventory: {
        ...observation.inventory,
        artifacts: observation.inventory.artifacts.map((artifact) =>
          artifact.id === "skill-one"
            ? { ...artifact, projectionPaths: [...artifact.projectionPaths, "plugins/pstack/codex/review/SKILL.md"] }
            : artifact,
        ),
      },
    };
    const catalogue = createResourceCatalogue({
      ...snapshot,
      roots: snapshot.roots.map((root) =>
        root.entry.id === "source-one"
          ? { entry: root.entry, evidence: { status: "observed" as const, observation: projected } }
          : root,
      ),
    });
    expect(catalogue.inspect(skillRef)!.files.map((file) => file.relativePath)).toContain(
      "plugins/pstack/codex/review/SKILL.md",
    );
    expect(
      catalogue
        .search("review")
        .filter((record) => record.ref.kind === "artifact" && record.ref.artifactId === "skill-one"),
    ).toHaveLength(1);
  });

  it("rejects stale observations and archived resources without guessing by name", () => {
    const before = JSON.stringify(snapshot);
    const stale = {
      ...snapshot,
      roots: snapshot.roots.map((root) =>
        root.entry.id === "source-one"
          ? {
              entry: root.entry,
              evidence: { status: "observed" as const, observation: resourceFixture.sourceObservation },
            }
          : root,
      ),
      registry: {
        ...snapshot.registry,
        sources: snapshot.registry.sources.map((entry) => ({ ...entry, availability: "missing" as const })),
      },
    };
    const catalogue = createResourceCatalogue(stale);
    expect(catalogue.browse(sourceRefResource)).toMatchObject({ status: "unavailable", children: [] });
    expect(catalogue.inspect(skillRef)).toBeNull();
    expect(
      catalogue.browse({ kind: "package", entry: { kind: "source", id: "missing" }, packageId: "pstack" }).status,
    ).toBe("not-found");
    const archived = {
      ...snapshot,
      registry: {
        ...snapshot.registry,
        sources: snapshot.registry.sources.map((entry) => ({ ...entry, archivedAt: "2026-10-04T10:00:00.000Z" })),
      },
    };
    expect(
      createResourceCatalogue(archived)
        .search("")
        .some((record) => record.ref.kind === "entry" && record.ref.entry.id === "source-one"),
    ).toBe(false);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("marks a subject-mismatched observation unavailable and ignores its inventory", () => {
    const mismatchedObservation = { ...resourceFixture.sourceObservation, subject: resourceFixture.projectTwoRef };
    const catalogue = createResourceCatalogue({
      ...snapshot,
      roots: snapshot.roots.map((root) =>
        root.entry.id === "source-one"
          ? { entry: root.entry, evidence: { status: "observed" as const, observation: mismatchedObservation } }
          : root,
      ),
    });
    expect(catalogue.browse(sourceRefResource)).toMatchObject({ status: "unavailable", children: [] });
    expect(catalogue.search("").some((resource) => resource.label === "pstack")).toBe(false);
  });

  it("preserves unavailable bindings and does not create a name-only relationship", () => {
    const unavailable = createResourceCatalogue({ ...snapshot, uses: { status: "unavailable" } });
    expect(unavailable.browse({ kind: "workspace" }).relations).toEqual([]);
    expect(unavailable.inspect(skillRef)?.uses).toEqual({ status: "unavailable" });
    const noUses = createResourceCatalogue({ ...snapshot, uses: { status: "ready", bindings: [] } });
    expect(noUses.browse({ kind: "workspace" }).relations).toEqual([]);
    expect(noUses.inspect(skillRef)?.uses).toEqual({ status: "ready", bindings: [] });
  });

  it("derives project groups from exact observed paths and package-relative source children", () => {
    const before = JSON.stringify(snapshot);
    const catalogue = createResourceCatalogue(snapshot);
    const groups = catalogue.projectSkillGroups(resourceFixture.projectOneRef);
    const packageRecord = catalogue
      .browse(sourceRefResource)
      .children.find((record) => record.kind === "plugin" && record.label === "pstack")!;

    expect(groups).toMatchObject([
      {
        id: JSON.stringify(["managed", "source-one", "pstack"]),
        category: "managed-plugin",
        label: "pstack",
        locations: [{ relativePath: ".claude/skills/review/SKILL.md" }],
      },
    ]);
    expect(catalogue.inspect(packageRecord.ref)?.packageFormat).toBe("claude-plugin");
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("keeps distinct observed harness projections as separate locations", () => {
    const withProjection = {
      ...snapshot,
      roots: snapshot.roots.map((root) =>
        root.entry.kind === "project" && root.entry.id === "project-one" && root.evidence.status === "observed"
          ? {
              ...root,
              evidence: {
                status: "observed" as const,
                observation: {
                  ...root.evidence.observation,
                  inventory: {
                    ...root.evidence.observation.inventory,
                    artifacts: root.evidence.observation.inventory.artifacts.map((artifact) =>
                      artifact.id === "project-skill"
                        ? {
                            ...artifact,
                            projectionPaths: [...artifact.projectionPaths, ".agents/skills/review/SKILL.md"],
                          }
                        : artifact,
                    ),
                  },
                },
              },
            }
          : root,
      ),
    };
    const locations = createResourceCatalogue(withProjection)
      .projectSkillGroups(resourceFixture.projectOneRef)[0]
      ?.locations.map((location) => location.relativePath);

    expect(locations).toEqual([".agents/skills/review/SKILL.md", ".claude/skills/review/SKILL.md"]);
  });

  it("retains location-specific origin and membership evidence in project details", () => {
    const projectEvidence = snapshot.roots.find(
      (root) => root.entry.kind === "project" && root.entry.id === "project-one",
    )!;
    const observation = projectEvidence.evidence.status === "observed" ? projectEvidence.evidence.observation : null;
    expect(observation).not.toBeNull();
    const evidence: SkillOriginEvidence = {
      artifactId: "project-skill",
      relativePath: ".claude/skills/review/SKILL.md",
      source: { kind: "github", locator: "owner/repo" },
      lockPath: "skills-lock.json",
      recordedHash: "a".repeat(64),
      verification: "modified",
    };
    const withOrigin = {
      ...snapshot,
      roots: snapshot.roots.map((root) =>
        root.entry.kind === "project" && root.entry.id === "project-one" && root.evidence.status === "observed"
          ? {
              ...root,
              evidence: {
                status: "observed" as const,
                observation: {
                  ...root.evidence.observation,
                  inventory: { ...root.evidence.observation.inventory, skillOrigins: [evidence] },
                },
              },
            }
          : root,
      ),
    };
    const catalogue = createResourceCatalogue(withOrigin);
    const details = catalogue.inspect({
      kind: "artifact",
      entry: resourceFixture.projectOneRef,
      artifactId: "project-skill",
    });

    expect(details?.skillOrigins).toEqual([evidence]);
    expect(details?.membershipIssues).toEqual([
      { relativePath: evidence.relativePath, reason: "assignment-origin-disagreement" },
    ]);
    expect(catalogue.projectSkillGroups(resourceFixture.projectOneRef)[0]?.category).toBe("managed-plugin");
    expect(observation?.inventory.skillOrigins).toBeUndefined();
  });

  it("returns no project groups for non-project entries or unobserved roots", () => {
    const catalogue = createResourceCatalogue(snapshot);
    expect(catalogue.projectSkillGroups(resourceFixture.sourceRef)).toEqual([]);
    expect(catalogue.projectSkillGroups(resourceFixture.projectTwoRef)).toEqual([]);
  });
});
