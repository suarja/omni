import { describe, expect, it } from "vitest";

import { parseSkillOriginEvidence, validateSkillOriginLocations } from "../../src/domain/skill-origins/validation";
import type { ObservedArtifact } from "../../src/domain/inventory";

function evidence(overrides: Record<string, unknown> = {}): unknown {
  return {
    artifactId: "skill-1",
    relativePath: ".agents/skills/review/SKILL.md",
    source: { kind: "github", locator: "Owner/Tools" },
    lockPath: "skills-lock.json",
    recordedHash: "A".repeat(64),
    verification: "unverified",
    verificationReason: "unavailable",
    ...overrides,
  };
}

const artifact: ObservedArtifact = {
  id: "skill-1",
  physicalIdentity: ".agents/skills/review/SKILL.md",
  projectionPaths: [".agents/skills/review/SKILL.md"],
  kind: "skill",
  relativePath: ".agents/skills/review/SKILL.md",
  displayPath: ".agents/skills/review/SKILL.md",
  providerIds: ["claude-code"],
  scope: "project",
  confidence: "exact",
  symlinkState: "none",
};

describe("skill origin evidence", () => {
  it("carries a normalized observed folder hash only with verified origin evidence", () => {
    expect(
      parseSkillOriginEvidence(
        evidence({ verification: "modified", verificationReason: undefined, copyHash: "B".repeat(64) }),
      ),
    ).toMatchObject({ copyHash: "b".repeat(64) });
    for (const value of [
      evidence({ copyHash: "b".repeat(64) }),
      evidence({ verification: "modified", verificationReason: undefined, copyHash: "unsafe" }),
      evidence({ verification: "modified", verificationReason: undefined, copyHash: "a".repeat(64) }),
      evidence({ verification: "matches-lock", verificationReason: undefined, copyHash: "b".repeat(64) }),
    ])
      expect(() => parseSkillOriginEvidence(value)).toThrow();
  });
  it("normalizes a safe GitHub locator and hash", () => {
    expect(parseSkillOriginEvidence(evidence())).toMatchObject({
      source: { kind: "github", locator: "owner/tools" },
      recordedHash: "a".repeat(64),
    });
  });

  it.each(["__proto__", "constructor", "prototype"])("accepts %s as a skill key", (skillKey) => {
    expect(parseSkillOriginEvidence(evidence({ skillKey }))).toMatchObject({ skillKey });
  });

  it("rejects unknown fields, unsafe paths and contradictory verification reasons", () => {
    for (const value of [
      evidence({ privateRoot: "/tmp/project" }),
      evidence({ relativePath: "../secret/SKILL.md" }),
      evidence({ verification: "matches-lock", verificationReason: "unavailable" }),
      evidence({ verification: "unverified", verificationReason: undefined }),
      evidence({ source: { kind: "github", locator: "owner/token@repo" } }),
    ]) {
      expect(() => parseSkillOriginEvidence(value)).toThrow();
    }
  });

  it("requires unique evidence for observed skill projection locations", () => {
    const parsed = parseSkillOriginEvidence(evidence());
    expect(() => validateSkillOriginLocations([parsed], [artifact])).not.toThrow();
    expect(() => validateSkillOriginLocations([parsed, parsed], [artifact])).toThrow();
    expect(() => validateSkillOriginLocations([parsed], [{ ...artifact, kind: "instruction" }])).toThrow();
    expect(() => validateSkillOriginLocations([parsed], [{ ...artifact, projectionPaths: [] }])).toThrow();
    expect(() => validateSkillOriginLocations([parsed], [])).toThrow();
  });
});
