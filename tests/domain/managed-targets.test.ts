import { describe, expect, it } from "vitest";

import { coversArtifact } from "../../src/domain/managed-targets";

describe("managed target coverage", () => {
  const folder = { relativePath: ".claude/skills/design-bank", unit: "folder" as const };
  const file = { relativePath: "AGENTS.md", unit: "file" as const };

  it("groups a managed skill's manifest and supporting files under its folder", () => {
    for (const relativePath of [
      folder.relativePath,
      `${folder.relativePath}/SKILL.md`,
      `${folder.relativePath}/scripts/check.ts`,
    ]) {
      expect(coversArtifact(folder, { relativePath, projectionPaths: [] })).toBe(true);
    }
  });

  it("keeps similarly named siblings and other harness roots independently visible", () => {
    for (const relativePath of [
      ".claude/skills/design-bank-extra/SKILL.md",
      ".agents/skills/design-bank/SKILL.md",
      "local/SKILL.md",
    ]) {
      expect(coversArtifact(folder, { relativePath, projectionPaths: [] })).toBe(false);
    }
  });

  it("covers a file target exactly without claiming descendants or suffixes", () => {
    expect(coversArtifact(file, { relativePath: "AGENTS.md", projectionPaths: [] })).toBe(true);
    for (const relativePath of ["AGENTS.md.backup", ["AGENTS.md", "child"].join("/"), "nested/AGENTS.md"]) {
      expect(coversArtifact(file, { relativePath, projectionPaths: [] })).toBe(false);
    }
  });

  it("recognizes an observed projection inside the managed folder", () => {
    expect(
      coversArtifact(folder, {
        relativePath: "physical/SKILL.md",
        projectionPaths: [".claude/skills/design-bank/SKILL.md"],
      }),
    ).toBe(true);
  });

  it("does not interpret traversal or absolute paths as managed descendants", () => {
    for (const relativePath of [
      ".claude/skills/design-bank/../local/SKILL.md",
      ".claude/skills/design-bank//SKILL.md",
      "/.claude/skills/design-bank/SKILL.md",
    ]) {
      expect(coversArtifact(folder, { relativePath, projectionPaths: [] })).toBe(false);
    }
  });
});
