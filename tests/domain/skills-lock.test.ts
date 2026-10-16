import { describe, expect, it } from "vitest";

import { parseSkillsLock } from "../../src/domain/skill-origins/skills-lock";

describe("skills-lock parser", () => {
  it("reads declared GitHub provenance without requiring an upstream skill path", () => {
    const result = parseSkillsLock({
      version: 1,
      skills: {
        review: { source: "Owner/tools", sourceType: "github", computedHash: "A".repeat(64) },
      },
    });

    expect(result).toEqual({
      entries: [
        {
          skillKey: "review",
          source: { kind: "github", locator: "owner/tools" },
          recordedHash: "a".repeat(64),
        },
      ],
      issues: [],
    });
  });

  it("accepts optional metadata and ignores unconsumed entry fields", () => {
    expect(
      parseSkillsLock({
        version: 1,
        skills: {
          review: {
            source: "owner/tools",
            sourceType: "github",
            computedHash: "b".repeat(64),
            skillPath: "skills/review",
            ref: "v1.2.0",
            futureField: { safe: true },
          },
        },
      }).entries,
    ).toEqual([
      {
        skillKey: "review",
        source: { kind: "github", locator: "owner/tools" },
        sourceSkillPath: "skills/review",
        reference: "v1.2.0",
        recordedHash: "b".repeat(64),
      },
    ]);
  });

  it("skips malformed entries independently and returns fixed safe diagnostics", () => {
    const result = parseSkillsLock({
      version: 1,
      skills: {
        good: { source: "owner/tools", sourceType: "github", computedHash: "c".repeat(64) },
        bad: { source: "https://user:secret@example.com/repo", sourceType: "git", computedHash: "secret" },
      },
    });

    expect(result.entries.map((entry) => entry.skillKey)).toEqual(["good"]);
    expect(result.issues).toEqual([
      { code: "unsupported", message: "A skills-lock entry uses an unsupported source type." },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|example\.com/);
  });

  it.each([
    ["missing lock", undefined],
    ["future version", { version: 2, skills: {} }],
    ["non-record lock", null],
  ])("reports unsupported structure for %s without throwing", (_label, input) => {
    expect(parseSkillsLock(input).entries).toEqual([]);
    expect(parseSkillsLock(input).issues[0]?.code).toBe("unsupported");
  });

  it.each([
    ["traversal key", "../review"],
    ["credential locator", "owner:token@repo/tools"],
    ["invalid hash", "0".repeat(63)],
    ["unsafe upstream path", "/skills/review"],
    ["control reference", "v1\nsecret"],
  ])("rejects %s", (label, invalid) => {
    const entry = { source: "owner/tools", sourceType: "github", computedHash: "d".repeat(64) };
    const lock =
      label === "traversal key"
        ? { version: 1, skills: { [invalid]: entry } }
        : {
            version: 1,
            skills: {
              review: {
                ...entry,
                ...(label === "credential locator" ? { source: invalid } : {}),
                ...(label === "invalid hash" ? { computedHash: invalid } : {}),
                ...(label === "unsafe upstream path" ? { skillPath: invalid } : {}),
                ...(label === "control reference" ? { ref: invalid } : {}),
              },
            },
          };

    expect(parseSkillsLock(lock).entries).toEqual([]);
    expect(parseSkillsLock(lock).issues[0]?.code).toBe("malformed");
  });

  it("preserves prototype-sensitive skill keys as ordinary lock entries", () => {
    const entry = { source: "owner/tools", sourceType: "github", computedHash: "d".repeat(64) };
    const lock = JSON.parse(
      `{"version":1,"skills":{"__proto__":${JSON.stringify(entry)},"constructor":${JSON.stringify(entry)},"prototype":${JSON.stringify(entry)}}}`,
    ) as unknown;

    expect(parseSkillsLock(lock)).toMatchObject({
      entries: ["__proto__", "constructor", "prototype"].map((skillKey) => ({ skillKey })),
      issues: [],
    });
  });
});
