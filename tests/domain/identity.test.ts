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

describe("artifact identity domain", () => {
  it("classifies executable inventory kinds and keeps other kinds static", () => {
    expect(executionClassForKind("hook")).toBe("executable");
    expect(executionClassForKind("mcp-config")).toBe("executable");
    expect(executionClassForKind("agent")).toBe("static");
    expect(executionClassForKind("command")).toBe("static");
  });

  it("derives packaged skill and file logical ids without absolute paths", () => {
    const skill = createArtifactIdentity({
      artifactId: "skill-a",
      contentHash: "b".repeat(64),
      byteLength: 45,
      kind: "skill",
      root: source,
      relativePath: "pstack/skills/architect/SKILL.md",
      package: packageRecord("pstack"),
    });
    const command = createArtifactIdentity({
      artifactId: "command-a",
      contentHash: "c".repeat(64),
      byteLength: 8,
      kind: "command",
      root: source,
      relativePath: "pstack/commands/check.md",
      package: packageRecord("pstack"),
    });

    expect(skill).toMatchObject({ logicalId: "pstack/skills/architect", executionClass: "static" });
    expect(command.logicalId).toBe("pstack/commands/check.md");
    expect(JSON.stringify([skill, command])).not.toMatch(/(?:^|[^A-Za-z0-9_])\//);
  });

  it("collapses every file inside a skills/<name>/ folder to the folder's logical id, any depth, any kind", () => {
    const packagedReference = createArtifactIdentity({
      artifactId: "packaged-reference",
      contentHash: "1".repeat(64),
      byteLength: 30,
      kind: "instruction",
      root: source,
      relativePath: "pstack/skills/architect/references/notes.md",
      package: packageRecord("pstack"),
    });
    const looseSkillFile = createArtifactIdentity({
      artifactId: "loose-skill",
      contentHash: "2".repeat(64),
      byteLength: 10,
      kind: "skill",
      root: source,
      relativePath: ".claude/skills/convex-setup-auth/SKILL.md",
    });
    const looseSkillReference = createArtifactIdentity({
      artifactId: "loose-skill-reference",
      contentHash: "3".repeat(64),
      byteLength: 12,
      kind: "instruction",
      root: source,
      relativePath: ".claude/skills/convex-setup-auth/references/clerk.md",
    });
    const looseSkillAsset = createArtifactIdentity({
      artifactId: "loose-skill-asset",
      contentHash: "4".repeat(64),
      byteLength: 4,
      kind: "unknown",
      root: source,
      relativePath: "skills/y/assets/icon.svg",
    });

    expect(packagedReference.logicalId).toBe("pstack/skills/architect");
    expect(looseSkillFile.logicalId).toBe("loose:.claude/skills/convex-setup-auth");
    expect(looseSkillReference.logicalId).toBe(looseSkillFile.logicalId);
    expect(looseSkillAsset.logicalId).toBe("loose:skills/y");
  });

  it("uses a loose logical id and preserves executable identity metadata", () => {
    const result = createArtifactIdentity({
      artifactId: "mcp-a",
      contentHash: "d".repeat(64),
      byteLength: 7,
      kind: "mcp-config",
      root: project,
      relativePath: "mcp/local.json",
    });

    expect(result).toEqual({
      artifactId: "mcp-a",
      logicalId: "loose:mcp/local.json",
      contentHash: "d".repeat(64),
      byteLength: 7,
      executionClass: "executable",
      kind: "mcp-config",
      provenance: { root: project, relativePath: "mcp/local.json" },
    });
  });

  it("derives one decision per root pair, root, logical id, and package — not one per artifact", () => {
    const identities = [
      identity({ artifactId: "loose-a", provenance: { root: project, relativePath: "a.md" }, logicalId: "loose:a.md" }),
      identity({ artifactId: "loose-b", provenance: { root: source, relativePath: "b.md" }, logicalId: "loose:b.md" }),
      identity({
        artifactId: "packaged-a",
        logicalId: "pstack/skills/review",
        contentHash: "e".repeat(64),
        provenance: { root: project, packageId: "pstack", relativePath: "pstack/skills/review/SKILL.md" },
      }),
      identity({
        artifactId: "packaged-b",
        logicalId: "pstack/skills/review",
        contentHash: "f".repeat(64),
        provenance: { root: source, packageId: "pstack", relativePath: "pstack/skills/review/SKILL.md" },
      }),
      identity({
        artifactId: "duplicate",
        logicalId: "loose:duplicate.md",
        provenance: { root: source, relativePath: "duplicate.md" },
      }),
    ];
    const findings = deriveIdentityFindings(
      identities,
      [packageRecord("pstack")],
      [
        {
          location: "pstack/omni.plugin.json",
          code: "malformed",
          severity: "warning",
          message: "Manifest is malformed.",
        },
      ],
    );

    expect(findings.map((finding) => finding.kind)).toEqual([
      "exact-duplicate",
      "loose",
      "unsupported-format",
      "variant",
    ]);
    expect(findings).toEqual([
      {
        kind: "exact-duplicate",
        severity: "info",
        roots: [project, source],
        count: 1,
        examples: ["a", "b", "duplicate"],
        contentHash: "a".repeat(64),
      },
      { kind: "loose", severity: "info", roots: [source], count: 2, examples: ["b", "duplicate"] },
      {
        kind: "unsupported-format",
        severity: "warning",
        roots: [project],
        count: 1,
        examples: ["SKILL"],
        packageId: "pstack",
      },
      {
        kind: "variant",
        severity: "warning",
        roots: [project, source],
        count: 2,
        examples: ["SKILL"],
        logicalId: "pstack/skills/review",
      },
    ]);
  });

  it("never produces a loose finding for a project root — that grouping is deferred to Brief 10", () => {
    const identities = [
      identity({
        artifactId: "project-loose-a",
        provenance: { root: project, relativePath: "a.md" },
        logicalId: "loose:a.md",
      }),
      identity({
        artifactId: "project-loose-b",
        contentHash: "b".repeat(64),
        provenance: { root: project, relativePath: "b.md" },
        logicalId: "loose:b.md",
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);

    expect(findings.some((finding) => finding.kind === "loose")).toBe(false);
  });

  it("disambiguates examples that share a basename but are different artifacts, using the logical id's parent segment", () => {
    const identities = [
      identity({
        artifactId: "ui-icon",
        contentHash: "1".repeat(64),
        logicalId: "loose:ui/icon.svg",
        provenance: { root: source, relativePath: "ui/icon.svg" },
      }),
      identity({
        artifactId: "core-icon",
        contentHash: "2".repeat(64),
        logicalId: "loose:core/icon.svg",
        provenance: { root: source, relativePath: "core/icon.svg" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);
    const loose = findings.find((finding) => finding.kind === "loose");

    expect(loose?.examples).toEqual(["icon (core)", "icon (ui)"]);
  });

  it("aggregates several duplicated files between the same two roots into a single finding", () => {
    const identities = [
      identity({
        artifactId: "one-a",
        contentHash: "1".repeat(64),
        logicalId: "loose:one.md",
        provenance: { root: project, relativePath: "one.md" },
      }),
      identity({
        artifactId: "one-b",
        contentHash: "1".repeat(64),
        logicalId: "loose:one.md",
        provenance: { root: source, relativePath: "one.md" },
      }),
      identity({
        artifactId: "two-a",
        contentHash: "2".repeat(64),
        logicalId: "loose:two.md",
        provenance: { root: project, relativePath: "two.md" },
      }),
      identity({
        artifactId: "two-b",
        contentHash: "2".repeat(64),
        logicalId: "loose:two.md",
        provenance: { root: source, relativePath: "two.md" },
      }),
    ];

    const findings = deriveIdentityFindings(identities, [], []);
    const duplicates = findings.filter((finding) => finding.kind === "exact-duplicate");

    expect(duplicates).toEqual([
      { kind: "exact-duplicate", severity: "info", roots: [project, source], count: 2, examples: ["one", "two"] },
    ]);
  });

  it("treats same-root projections sharing a physical identity as one artifact and excludes manifests from duplicate and loose findings", () => {
    const identities = [
      identity({
        artifactId: "agents-artifact",
        contentHash: "c".repeat(64),
        logicalId: "loose:AGENTS.md",
        provenance: { root: source, relativePath: "AGENTS.md" },
      }),
      identity({
        artifactId: "claude-artifact",
        contentHash: "c".repeat(64),
        logicalId: "loose:CLAUDE.md",
        provenance: { root: source, relativePath: "CLAUDE.md" },
      }),
      identity({
        artifactId: "manifest-project",
        kind: "plugin-manifest",
        contentHash: "d".repeat(64),
        logicalId: "loose:omni.plugin.json",
        provenance: { root: project, relativePath: "omni.plugin.json" },
      }),
      identity({
        artifactId: "manifest-source",
        kind: "plugin-manifest",
        contentHash: "d".repeat(64),
        logicalId: "loose:omni.plugin.json",
        provenance: { root: source, relativePath: "omni.plugin.json" },
      }),
    ];
    const physicalIdentities: PhysicalIdentityLookup = new Map([
      ["agents-artifact", "AGENTS.md"],
      ["claude-artifact", "AGENTS.md"],
    ]);

    const findings = deriveIdentityFindings(identities, [], [], physicalIdentities);

    expect(findings).toEqual([{ kind: "loose", severity: "info", roots: [source], count: 1, examples: ["AGENTS"] }]);
  });
});
