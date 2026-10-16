import { describe, expect, it } from "vitest";
import { parseSkillIntent } from "../../src/shared/skill-management-ipc";

describe("external skill operation requests", () => {
  it.each(["__proto__", "constructor", "prototype"])("accepts a safe %s skill install", (skillName) => {
    const request = {
      kind: "install-external-skill",
      sourceId: "fixture/tools",
      skillPath: `skills/${skillName}`,
      skillName,
      targets: [{ projectId: "project-a", harnessIds: ["codex", "claude-code"] }],
      conflict: "refuse",
    };
    expect(parseSkillIntent(request)).toEqual(request);
  });
  it("accepts one source and distinct uses for an update", () => {
    const request = { kind: "update-external-skills", sourceId: "fixture/tools", useIds: ["a", "b"] };
    expect(parseSkillIntent(request)).toEqual(request);
  });
  it("accepts explicit per-file merge choices", () => {
    const request = {
      kind: "merge-external-skill",
      sourceId: "fixture/tools",
      useId: "a",
      choices: [{ path: "SKILL.md", choice: "mine" }],
    };
    expect(parseSkillIntent(request)).toEqual(request);
  });
  it.each(["../escape", "/absolute", "a/b", "bad\\name"])("refuses unsafe skill name %s", (skillName) => {
    expect(() =>
      parseSkillIntent({
        kind: "install-external-skill",
        sourceId: "fixture/tools",
        skillPath: "skills/demo",
        skillName,
        targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
        conflict: "refuse",
      }),
    ).toThrow();
  });
  it("refuses unknown fields, duplicate uses and unsupported agents", () => {
    expect(() =>
      parseSkillIntent({ kind: "update-external-skills", sourceId: "fixture/tools", useIds: ["a", "a"] }),
    ).toThrow();
    expect(() =>
      parseSkillIntent({ kind: "update-external-skills", sourceId: "fixture/tools", useIds: ["a"], auto: true }),
    ).toThrow();
    expect(() =>
      parseSkillIntent({
        kind: "install-external-skill",
        sourceId: "fixture/tools",
        skillPath: "skills/demo",
        skillName: "demo",
        targets: [{ projectId: "project-a", harnessIds: ["cursor"] }],
        conflict: "refuse",
      }),
    ).toThrow();
  });
});
