import { describe, expect, it } from "vitest";

import type { ArtifactIdentity } from "../../src/domain/identity";
import type { Observation } from "../../src/domain/project-source-registry";
import type { AuditObservation, AuditReport } from "../../src/renderer/audit/audit-report";
import { buildCatalogue, projectContext } from "../../src/renderer/catalogue/catalogue";

const personal = { kind: "source" as const, id: "personal" };
const external = { kind: "source" as const, id: "external" };
const project = { kind: "project" as const, id: "project" };
const emptyProject = { kind: "project" as const, id: "empty-project" };

function identity(overrides: Partial<ArtifactIdentity>): ArtifactIdentity {
  return {
    artifactId: "artifact",
    logicalId: "loose:.claude/skills/review",
    contentHash: "a".repeat(64),
    byteLength: 10,
    executionClass: "static",
    kind: "skill",
    provenance: { root: personal, relativePath: ".claude/skills/review/SKILL.md" },
    ...overrides,
  };
}

function observation(
  subject: Observation["subject"],
  identities: readonly ArtifactIdentity[],
  physicalIdentity?: string,
): AuditObservation {
  return {
    subject,
    observedAt: "2026-09-12T10:00:00.000Z",
    identities,
    inventory: {
      rootHandle: `${subject.kind}-${subject.id}`,
      displayRoot: subject.id,
      observedAt: "2026-09-12T10:00:00.000Z",
      harnesses: ["claude"],
      artifacts: identities.map((item) => ({
        id: item.artifactId,
        physicalIdentity: physicalIdentity ?? item.provenance.relativePath,
        projectionPaths: [item.provenance.relativePath],
        kind: item.kind,
        relativePath: item.provenance.relativePath,
        displayPath: item.provenance.relativePath,
        providerIds: [],
        scope: subject.kind === "source" ? "source" : "project",
        confidence: "exact",
        symlinkState: "none",
        ...(item.provenance.packageId ? { packageId: item.provenance.packageId } : {}),
      })),
      packages: [],
      diagnostics: [],
      gitScopes: [],
    },
  };
}

const registry = {
  revision: 1,
  projects: [
    { ref: project, displayName: "Project", displayRoot: "project", availability: "available" as const },
    { ref: emptyProject, displayName: "Empty", displayRoot: "empty", availability: "available" as const },
  ],
  sources: [
    {
      ref: personal,
      displayName: "Personal",
      displayRoot: "personal",
      availability: "available" as const,
      ownership: "personal" as const,
      capabilities: { observe: true as const, write: false as const },
    },
    {
      ref: external,
      displayName: "External",
      displayRoot: "external",
      availability: "available" as const,
      ownership: "external" as const,
      capabilities: { observe: true as const, write: false as const },
    },
  ],
};

describe("catalogue read model", () => {
  it("folds a skill folder per root and derives project state from the personal source", () => {
    const personalSkill = identity({
      artifactId: "personal-skill",
      contentHash: "a".repeat(64),
      provenance: { root: personal, packageId: "omni", relativePath: "omni/skills/review/SKILL.md" },
      logicalId: "omni/skills/review",
    });
    const personalReference = identity({
      artifactId: "personal-reference",
      kind: "instruction",
      contentHash: "b".repeat(64),
      provenance: { root: personal, packageId: "omni", relativePath: "omni/skills/review/references/notes.md" },
      logicalId: "omni/skills/review",
    });
    const projectSkill = identity({
      artifactId: "project-skill",
      contentHash: "c".repeat(64),
      provenance: { root: project, relativePath: ".agents/skills/review/SKILL.md" },
      logicalId: "loose:.agents/skills/review",
    });
    const unmanaged = identity({
      artifactId: "unmanaged",
      kind: "instruction",
      contentHash: "e".repeat(64),
      logicalId: "loose:AGENTS.md",
      provenance: { root: project, relativePath: "AGENTS.md" },
    });
    const externalCommand = identity({
      artifactId: "external-command",
      kind: "command",
      logicalId: "external/commands/check.md",
      contentHash: "d".repeat(64),
      provenance: { root: external, packageId: "external", relativePath: "external/commands/check.md" },
    });
    const report: AuditReport = {
      observations: [
        observation(personal, [personalSkill, personalReference]),
        observation(project, [projectSkill, unmanaged]),
        observation(external, [externalCommand]),
      ],
      findings: [],
      unavailable: [],
    };

    const catalogue = buildCatalogue({ registry, report, entryIdentities: {} });

    expect(catalogue.map((unit) => unit.name)).toEqual(["AGENTS", "check", "review"]);
    const review = catalogue.find((unit) => unit.name === "review");
    expect(review?.unit).toBe("skill-folder");
    expect(review?.occurrences).toHaveLength(2);
    expect(review?.inPersonalSource).toBe(true);
    expect(projectContext(catalogue, project)).toEqual({
      managed: [{ unit: review, state: "modified" }],
      unmanaged: [{ unit: catalogue.find((unit) => unit.name === "AGENTS"), state: "unmanaged" }],
      available: [],
    });
  });

  it("falls back to the entry identity cache and leaves roots without identities unrepresented", () => {
    const cached = identity({
      artifactId: "cached",
      kind: "command",
      logicalId: "personal/commands/check.md",
      provenance: { root: personal, relativePath: "commands/check.md" },
    });
    const entryIdentities: Readonly<Record<string, AuditObservation>> = {
      "source:personal": observation(personal, [cached]),
    };
    const catalogue = buildCatalogue({
      registry,
      report: { observations: [], findings: [], unavailable: [] },
      entryIdentities,
    });

    expect(catalogue.map((unit) => unit.name)).toEqual(["check"]);
    expect(catalogue.every((unit) => unit.occurrences.every((occurrence) => occurrence.root.id === "personal"))).toBe(
      true,
    );
  });
});
