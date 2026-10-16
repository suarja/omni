import { describe, expect, it } from "vitest";

import { buildCompatibilityReport } from "../../src/domain/compatibility-report";

describe("compatibility report", () => {
  it("classifies local artifacts, marker refinements, and remote declarations", () => {
    const report = buildCompatibilityReport({
      harness: "codex",
      marketplace: {
        packages: [
          {
            id: "skills-only",
            relativeRoot: "packages/skills-only",
            manifestPaths: ["packages/skills-only/.claude-plugin/plugin.json"],
          },
          {
            id: "commands",
            relativeRoot: "packages/commands",
            manifestPaths: ["packages/commands/.claude-plugin/plugin.json"],
          },
        ],
        artifacts: [
          { packageId: "skills-only", kind: "skill", path: "skills/review/SKILL.md" },
          { packageId: "commands", kind: "command", path: "commands/review.md", content: "Use $ARGUMENTS\n" },
        ],
        remotePackages: [{ name: "remote", source: { source: "github", repo: "owner/remote", ref: "v1" } }],
      },
    });

    expect(report.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageId: "skills-only", verdict: "ready" }),
        expect.objectContaining({
          packageId: "commands",
          verdict: "partial",
          reason: expect.stringContaining("$ARGUMENTS"),
        }),
        expect.objectContaining({ packageId: "remote", path: "remote", verdict: "remote" }),
      ]),
    );
    expect(report.packages.find((item) => item.packageId === "commands")?.artifacts).toEqual([
      expect.objectContaining({ status: "not-transposable", reason: expect.stringContaining("$ARGUMENTS") }),
    ]);
  });

  it("marks a complete target projection as already compatible", () => {
    const report = buildCompatibilityReport({
      harness: "codex",
      marketplace: {
        packages: [
          {
            id: "tools",
            relativeRoot: "packages/tools",
            manifestPaths: ["packages/tools/.codex-plugin/plugin.json"],
          },
        ],
        artifacts: [{ packageId: "tools", kind: "skill", path: "skills/review/SKILL.md" }],
      },
    });

    expect(report.packages[0]).toMatchObject({ verdict: "ready", alreadyCompatible: true });
  });

  it("refines Codex eligibility for frontmatter, tool-naming agents, and hooks", () => {
    const report = buildCompatibilityReport({
      harness: "codex",
      marketplace: {
        packages: [{ id: "claude-only", relativeRoot: "packages/claude-only", manifestPaths: [] }],
        artifacts: [
          {
            packageId: "claude-only",
            kind: "skill",
            path: "skills/restricted/SKILL.md",
            frontmatter: { "allowed-tools": ["Bash"] },
          },
          { packageId: "claude-only", kind: "agent", path: "agents/reviewer.md", content: "Use Read and Grep." },
          { packageId: "claude-only", kind: "hook", path: "hooks/hooks.json", content: "{}" },
        ],
      },
    });

    expect(report.packages[0]).toMatchObject({ verdict: "partial" });
    expect(report.packages[0]?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "not-transposable", reason: expect.stringContaining("allowed-tools") }),
        expect.objectContaining({ status: "not-transposable", reason: expect.stringContaining("tools") }),
        expect.objectContaining({ status: "not-transposable", reason: expect.stringContaining("hook") }),
      ]),
    );
  });
});
