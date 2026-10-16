import { describe, expect, it } from "vitest";

import type { ObservedPackage } from "../../src/domain/inventory";
import type { EntryRef } from "../../src/domain/project-source-registry";
import {
  createArtifactIdentity,
  deriveIdentityFindings,
  executionClassForKind,
  type ArtifactIdentity,
  type PhysicalIdentityLookup,
} from "../../src/domain/identity";
import { identity, packageRecord, project, source } from "./identity-helpers";

describe("artifact identity findings", () => {
  it("treats a loose skill folder as one logical unit: one variant finding naming only the basenames that differ", () => {
    const identities = [
      identity({
        artifactId: "skill-source",
        kind: "skill",
        contentHash: "1".repeat(64),
        logicalId: "loose:.claude/skills/convex-setup-auth",
        provenance: { root: source, relativePath: ".claude/skills/convex-setup-auth/SKILL.md" },
      }),
      identity({
        artifactId: "clerk-source",
        kind: "instruction",
        contentHash: "2".repeat(64),
        logicalId: "loose:.claude/skills/convex-setup-auth",
        provenance: { root: source, relativePath: ".claude/skills/convex-setup-auth/references/clerk.md" },
      }),
      identity({
        artifactId: "skill-project",
        kind: "skill",
        contentHash: "1".repeat(64),
        logicalId: "loose:.claude/skills/convex-setup-auth",
        provenance: { root: project, relativePath: ".claude/skills/convex-setup-auth/SKILL.md" },
      }),
      identity({
        artifactId: "clerk-project",
        kind: "instruction",
        contentHash: "3".repeat(64),
        logicalId: "loose:.claude/skills/convex-setup-auth",
        provenance: { root: project, relativePath: ".claude/skills/convex-setup-auth/references/clerk.md" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);
    const variants = findings.filter((finding) => finding.kind === "variant");

    expect(variants).toEqual([
      {
        kind: "variant",
        severity: "warning",
        roots: [project, source],
        count: 4,
        examples: ["clerk"],
        logicalId: "loose:.claude/skills/convex-setup-auth",
      },
    ]);
  });

  it("never produces a variant finding for kinds outside the reusable unit set (instruction files never differ into a variant)", () => {
    const identities = [
      identity({
        artifactId: "instruction-a",
        kind: "instruction",
        contentHash: "5".repeat(64),
        logicalId: "loose:review.md",
        provenance: { root: project, relativePath: "review.md" },
      }),
      identity({
        artifactId: "instruction-b",
        kind: "instruction",
        contentHash: "6".repeat(64),
        logicalId: "loose:notes/review.md",
        provenance: { root: source, relativePath: "notes/review.md" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);

    expect(findings.some((finding) => finding.kind === "variant")).toBe(false);
  });

  it("counts a skill folder as one exact-duplicate unit when every file inside it matches across roots", () => {
    const identities = [
      identity({
        artifactId: "skill-project",
        kind: "skill",
        contentHash: "a".repeat(64),
        logicalId: "loose:.claude/skills/x",
        provenance: { root: project, relativePath: ".claude/skills/x/SKILL.md" },
      }),
      identity({
        artifactId: "notes-project",
        kind: "instruction",
        contentHash: "b".repeat(64),
        logicalId: "loose:.claude/skills/x",
        provenance: { root: project, relativePath: ".claude/skills/x/references/notes.md" },
      }),
      identity({
        artifactId: "skill-source",
        kind: "skill",
        contentHash: "a".repeat(64),
        logicalId: "loose:.claude/skills/x",
        provenance: { root: source, relativePath: ".claude/skills/x/SKILL.md" },
      }),
      identity({
        artifactId: "notes-source",
        kind: "instruction",
        contentHash: "b".repeat(64),
        logicalId: "loose:.claude/skills/x",
        provenance: { root: source, relativePath: ".claude/skills/x/references/notes.md" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);
    const duplicate = findings.find((finding) => finding.kind === "exact-duplicate");

    expect(duplicate).toMatchObject({
      kind: "exact-duplicate",
      severity: "info",
      roots: [project, source],
      count: 1,
      examples: ["x"],
    });
  });

  it("does not parenthesize an example whose parent segment equals its own name, only when disambiguation is needed", () => {
    const identities = [
      identity({
        artifactId: "self-parented",
        contentHash: "7".repeat(64),
        logicalId: "loose:codebase-design/codebase-design.md",
        provenance: { root: source, relativePath: "codebase-design/codebase-design.md" },
      }),
      identity({
        artifactId: "other-parented",
        contentHash: "8".repeat(64),
        logicalId: "loose:other/codebase-design.md",
        provenance: { root: source, relativePath: "other/codebase-design.md" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);
    const loose = findings.find((finding) => finding.kind === "loose");

    expect(loose?.examples).toEqual(["codebase-design", "codebase-design (other)"]);
    expect(loose?.examples).not.toContain("codebase-design (codebase-design)");
  });

  it("returns no findings for empty identity evidence", () => {
    expect(deriveIdentityFindings([], [], [])).toEqual([]);
  });

  it("does not fold two different loose skill folders sharing a root into one exact-duplicate group when their file hashes differ", () => {
    const identities = [
      identity({
        artifactId: "foo-skill",
        kind: "skill",
        contentHash: "1".repeat(64),
        logicalId: "loose:.claude/skills/foo",
        provenance: { root: source, relativePath: ".claude/skills/foo/SKILL.md" },
      }),
      identity({
        artifactId: "foo-notes",
        kind: "instruction",
        contentHash: "2".repeat(64),
        logicalId: "loose:.claude/skills/foo",
        provenance: { root: source, relativePath: ".claude/skills/foo/references/notes.md" },
      }),
      identity({
        artifactId: "bar-skill",
        kind: "skill",
        contentHash: "3".repeat(64),
        logicalId: "loose:.claude/skills/bar",
        provenance: { root: source, relativePath: ".claude/skills/bar/SKILL.md" },
      }),
      identity({
        artifactId: "bar-notes",
        kind: "instruction",
        contentHash: "4".repeat(64),
        logicalId: "loose:.claude/skills/bar",
        provenance: { root: source, relativePath: ".claude/skills/bar/references/notes.md" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);

    expect(findings.some((finding) => finding.kind === "exact-duplicate")).toBe(false);
  });

  it("folds two folders with identical relative file names and identical hashes into one exact-duplicate group, leaving contentHash undefined for the folded folder unit", () => {
    const identities = [
      identity({
        artifactId: "skill-claude",
        kind: "skill",
        contentHash: "1".repeat(64),
        logicalId: "loose:.claude/skills/x",
        provenance: { root: source, relativePath: ".claude/skills/x/SKILL.md" },
      }),
      identity({
        artifactId: "notes-claude",
        kind: "instruction",
        contentHash: "2".repeat(64),
        logicalId: "loose:.claude/skills/x",
        provenance: { root: source, relativePath: ".claude/skills/x/references/notes.md" },
      }),
      identity({
        artifactId: "skill-agents",
        kind: "skill",
        contentHash: "1".repeat(64),
        logicalId: "loose:.agents/skills/x",
        provenance: { root: source, relativePath: ".agents/skills/x/SKILL.md" },
      }),
      identity({
        artifactId: "notes-agents",
        kind: "instruction",
        contentHash: "2".repeat(64),
        logicalId: "loose:.agents/skills/x",
        provenance: { root: source, relativePath: ".agents/skills/x/references/notes.md" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);
    const duplicate = findings.find((finding) => finding.kind === "exact-duplicate");

    expect(duplicate).toMatchObject({
      kind: "exact-duplicate",
      severity: "info",
      roots: [source],
      count: 1,
      examples: ["x"],
    });
    expect(duplicate?.contentHash).toBeUndefined();
  });

  it("keeps contentHash defined and a valid sha256 for a single-file exact-duplicate unit (not a folded folder)", () => {
    const identities = [
      identity({
        artifactId: "one-a",
        contentHash: "9".repeat(64),
        logicalId: "loose:one.md",
        provenance: { root: project, relativePath: "one.md" },
      }),
      identity({
        artifactId: "one-b",
        contentHash: "9".repeat(64),
        logicalId: "loose:one.md",
        provenance: { root: source, relativePath: "one.md" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);
    const duplicate = findings.find((finding) => finding.kind === "exact-duplicate");

    expect(duplicate?.contentHash).toBe("9".repeat(64));
    expect(duplicate?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("gives two skill folders with genuinely different content different grouping keys, even with the same file count and names", () => {
    const foo = [
      identity({
        artifactId: "foo-skill",
        kind: "skill",
        contentHash: "1".repeat(64),
        logicalId: "loose:.claude/skills/foo",
        provenance: { root: source, relativePath: ".claude/skills/foo/SKILL.md" },
      }),
      identity({
        artifactId: "foo-notes",
        kind: "instruction",
        contentHash: "2".repeat(64),
        logicalId: "loose:.claude/skills/foo",
        provenance: { root: source, relativePath: ".claude/skills/foo/references/notes.md" },
      }),
    ];
    const bar = [
      identity({
        artifactId: "bar-skill",
        kind: "skill",
        contentHash: "3".repeat(64),
        logicalId: "loose:.claude/skills/bar",
        provenance: { root: source, relativePath: ".claude/skills/bar/SKILL.md" },
      }),
      identity({
        artifactId: "bar-notes",
        kind: "instruction",
        contentHash: "4".repeat(64),
        logicalId: "loose:.claude/skills/bar",
        provenance: { root: source, relativePath: ".claude/skills/bar/references/notes.md" },
      }),
    ];

    const findings = deriveIdentityFindings([...foo, ...bar], [], []);

    expect(findings.some((finding) => finding.kind === "exact-duplicate")).toBe(false);
  });

  it("counts five identically-duplicated skill folders (two conventions each) inside one root as five exact-duplicate units", () => {
    const names = ["a", "b", "c", "d", "e"];
    const identities = names.flatMap((name, index) => {
      const hash = String(index + 1)
        .repeat(64)
        .slice(0, 64);
      return [
        identity({
          artifactId: `${name}-claude`,
          kind: "skill",
          contentHash: hash,
          logicalId: `loose:.claude/skills/${name}`,
          provenance: { root: source, relativePath: `.claude/skills/${name}/SKILL.md` },
        }),
        identity({
          artifactId: `${name}-agents`,
          kind: "skill",
          contentHash: hash,
          logicalId: `loose:.agents/skills/${name}`,
          provenance: { root: source, relativePath: `.agents/skills/${name}/SKILL.md` },
        }),
      ];
    });

    const findings = deriveIdentityFindings(identities, [], []);
    const duplicate = findings.find((finding) => finding.kind === "exact-duplicate");

    expect(duplicate).toMatchObject({ kind: "exact-duplicate", severity: "info", roots: [source], count: 5 });
    expect(duplicate?.examples).toHaveLength(3);
  });

  it("treats a symlinked skill-folder directory resolving to a folder member as a projection", () => {
    const identities = [
      identity({
        artifactId: "target",
        kind: "skill",
        logicalId: "loose:.claude/skills/x",
        provenance: { root: source, relativePath: ".claude/skills/x/SKILL.md" },
      }),
      identity({
        artifactId: "projection",
        kind: "skill",
        logicalId: "loose:.agents/skills/x",
        provenance: { root: source, relativePath: ".agents/skills/x" },
      }),
    ];
    const physicalIdentities: PhysicalIdentityLookup = new Map([
      ["target", ".shared/skills/x/SKILL.md"],
      ["projection", ".shared/skills/x"],
    ]);

    expect(deriveIdentityFindings(identities, [], [], physicalIdentities)).toEqual([
      { kind: "loose", severity: "info", roots: [source], count: 1, examples: ["x"] },
    ]);
  });
});
