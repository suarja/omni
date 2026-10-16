import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { planSkillPropagationTarget } from "../../src/domain/skill-reconciliation/propagation";
import { normalizeSkillIntent } from "../../src/domain/skill-management-intent";
import type { SkillRevision } from "../../src/domain/skill-reconciliation/types";

function revision(value: string): SkillRevision {
  return {
    algorithm: "omni-tree-v1",
    hash: createHash("sha256").update(value).digest("hex"),
    files: [{ path: "SKILL.md", hash: createHash("sha256").update(value).digest("hex"), byteLength: value.length }],
  };
}

describe("linked skill propagation eligibility", () => {
  const source = revision("source");
  const base = revision("base");
  const edited = revision("local edit");

  it.each([
    ["current", source, source, source, true, true, "current"],
    ["source and local are current but base is old", source, source, base, true, true, "already-current"],
    ["local equals the verified base", source, base, base, true, true, "eligible"],
    ["local diverges from both source and base", source, edited, base, true, true, "retained-local"],
    ["unbound copy", source, base, base, false, true, "withheld"],
    ["unsafe target", source, base, base, true, false, "withheld"],
    ["missing immutable base", source, base, undefined, true, true, "withheld"],
  ] as const)("plans %s", (_label, currentSource, local, immutableBase, managed, safe, expected) => {
    expect(
      planSkillPropagationTarget({
        source: currentSource,
        local,
        ...(immutableBase ? { base: immutableBase } : {}),
        managed,
        safe,
      }),
    ).toBe(expected);
  });

  it("keeps source-only updates target-free and normalizes selected locations", () => {
    const sourceOnly = normalizeSkillIntent({
      kind: "write",
      request: {
        kind: "write-skill",
        sourceId: "source-a",
        packageId: "packages/tools",
        mode: "update",
        folderName: "tool",
        files: [{ path: "SKILL.md", content: "updated" }],
      },
    });
    const propagated = normalizeSkillIntent({
      kind: "maintain-current",
      source: { sourceId: "source-a", packageId: "packages/tools", artifactPath: "skills/tool" },
      locations: [
        { projectId: "project-b", harnessId: "codex", folderPath: ".agents/skills/tool" },
        { projectId: "project-a", harnessId: "claude-code", folderPath: ".claude/skills/tool" },
      ],
    });

    expect(sourceOnly.kind).toBe("write");
    expect(propagated).toMatchObject({
      kind: "maintain-current",
      locations: [{ projectId: "project-a" }, { projectId: "project-b" }],
    });
  });
});
