import { expect, it } from "vitest";
import {
  externalSkillTargets,
  resolveExternalSkill,
  externalSkillTitle,
} from "../../src/renderer/canvas/pages/external-skill-selection";
import { detailsFixture, useFixture } from "./external-library-fixture";

it("keeps returned paths separate and groups removed copies only by their retained source path", () => {
  const details = detailsFixture();
  details.skills.push({ ...details.skills[0]!, path: "plugins/second/skills/grill-me", useIds: [] });
  details.uses.push({ ...useFixture("old-two", "removed"), skillKey: "old-tool", skillPath: "skills/old-tool" });
  details.uses.push({
    ...useFixture("old-other-path", "removed"),
    skillKey: "old-tool",
    skillPath: "plugins/second/skills/old-tool",
  });
  details.uses.push({ ...useFixture("unknown-path", "removed"), skillKey: "old-tool", skillPath: undefined });
  const targets = externalSkillTargets(details);
  expect(targets.filter((target) => target.skillName === "grill-me")).toHaveLength(2);
  expect(targets.filter((target) => target.skillName === "old-tool")).toHaveLength(3);
  const resolved = resolveExternalSkill(details, { skillName: "old-tool", useId: "old-two" });
  expect(resolved.uses.map((use) => use.id)).toEqual(["old-tool", "old-two"]);
  expect(resolved.removed!.id).toBe("old-two");
  expect(
    resolveExternalSkill(details, { skillName: "old-tool", useId: "unknown-path" }).uses.map((use) => use.id),
  ).toEqual(["unknown-path"]);
  expect(externalSkillTitle(details, { skillName: "fresh-tool", skillPath: "skills/fresh-tool" })).toBe("fresh-tool");
});

it("refuses an explicit path or use that is absent or contradicts the selected live copy", () => {
  const details = detailsFixture();
  details.skills.push({ ...details.skills[0]!, path: "plugins/second/skills/grill-me", useIds: [] });
  for (const target of [
    { skillName: "grill-me", skillPath: "missing/skills/grill-me" },
    { skillName: "grill-me", useId: "missing-use" },
    { skillName: "grill-me", useId: "grill-me", skillPath: "plugins/second/skills/grill-me" },
    { skillName: "grill-me" },
  ]) {
    expect(resolveExternalSkill(details, target)).toEqual({ uses: [] });
  }
});
