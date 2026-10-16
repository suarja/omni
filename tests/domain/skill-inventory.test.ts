import { describe, expect, it } from "vitest";
import {
  compactSkillInventoryUnit,
  compactSkillInventoryIdentity,
  readSkillInventoryPage,
} from "../../src/domain/skill-inventory-limits";
import { deriveSkillInventoryIdentity } from "../../src/domain/skill-inventory";
import type {
  SkillInventoryReadUnit,
  SkillInventoryScope,
  SkillInventorySnapshot,
} from "../../src/shared/skill-inventory";

const scope: SkillInventoryScope = {
  key: "p0",
  kind: "project",
  projectId: "project",
  name: "Fixture",
  root: "/tmp/fixture",
};
function unit(index: number): SkillInventoryReadUnit {
  return {
    id: `unit-${index}`,
    name: `skill-${index}`,
    scope: "project",
    locations: [{ harness: "codex", folder: `.agents/skills/skill-${index}` }],
    origin: { kind: "local" },
    description: "x".repeat(240),
    files: 1,
    lines: 8,
    contentHash: String(index).padStart(64, "a"),
    skillMdPath: `/tmp/fixture/.agents/skills/skill-${index}/SKILL.md`,
  };
}
function snapshot(units: readonly SkillInventoryReadUnit[]): SkillInventorySnapshot {
  return {
    status: "ready",
    scopes: [scope],
    units: units.map((unit) => compactSkillInventoryUnit(unit, scope)),
    identity: compactSkillInventoryIdentity(deriveSkillInventoryIdentity(units, [])),
    unavailable: [],
    limits: [],
  };
}
describe("compact inventory pages", () => {
  it("preserves complete small inventories with relative paths and no default-field duplication", () => {
    const original = snapshot([unit(0)]);
    const page = readSkillInventoryPage(original, 0, String);
    expect(page.units).toHaveLength(1);
    expect(page.scopes).toEqual([scope]);
    expect(page.units[0]).toMatchObject({
      id: "unit-0",
      scope: "p0",
      path: ".agents/skills/skill-0/SKILL.md",
      hash: "a".repeat(12),
    });
    for (const field of ["origin", "files", "locations", "skillMdPath", "contentHash"])
      expect(page.units[0]).not.toHaveProperty(field);
    expect(page.units[0]?.description).toHaveLength(160);
    expect(page.identity).toEqual(original.identity);
    expect(page.nextCursor).toBeUndefined();
  });
  it("returns every unit across bounded pages with identity only on the first page", () => {
    const original = snapshot(Array.from({ length: 111 }, (_, index) => unit(index)));
    const ids: string[] = [];
    let offset = 0;
    let pages = 0;
    do {
      const page = readSkillInventoryPage(original, offset, String);
      expect(JSON.stringify(page).length).toBeLessThan(20_000);
      expect(page.identity).toEqual(pages === 0 ? original.identity : undefined);
      ids.push(...page.units.map((unit) => unit.id));
      pages++;
      offset = page.nextCursor ? Number(page.nextCursor) : original.units.length;
    } while (offset < original.units.length);
    expect(ids).toEqual(original.units.map((unit) => unit.id));
    expect(pages).toBeLessThanOrEqual(2);
    expect(original.units).toHaveLength(111);
  });
  it("refuses oversized metadata with a recovery path instead of dropping unread roots or diagnostics", () => {
    const original = {
      ...snapshot([]),
      unavailable: Array.from({ length: 200 }, (_, i) => ({
        projectId: String(i),
        name: "x".repeat(240),
        reason: "missing",
      })),
      limits: Array.from({ length: 200 }, (_, i) => ({
        scope: String(i),
        path: "x".repeat(512),
        reason: "unsafe-tree",
      })),
    };
    expect(() => readSkillInventoryPage(original, 0, String)).toThrow("select fewer projects");
    expect(original.unavailable).toHaveLength(200);
    expect(original.limits).toHaveLength(200);
  });
  it("compares full hashes even when the twelve-character display prefixes collide", () => {
    const left = { ...unit(0), name: "review", contentHash: "a".repeat(64) };
    const right = { ...unit(1), name: "review", contentHash: "a".repeat(12) + "b".repeat(52) };
    const findings = compactSkillInventoryIdentity(deriveSkillInventoryIdentity([left, right], []));
    expect(findings.byName).toEqual([
      expect.objectContaining({ name: "review", kinds: ["sameNameDifferentContent"], units: [left.id, right.id] }),
    ]);
    expect(findings.sameContentDifferentNames).toEqual([]);
    expect(compactSkillInventoryUnit(left, scope).hash).toBe(compactSkillInventoryUnit(right, scope).hash);
  });
  it("aggregates long descriptions once and reaches 128 units in at most three pages", () => {
    const original = {
      ...snapshot(Array.from({ length: 128 }, (_, index) => unit(index))),
      limits: Array.from({ length: 128 }, (_, index) => ({
        scope: "project",
        path: `skills/skill-${index}`,
        reason: "description-capped-at-160",
      })),
    };
    const ids: string[] = [];
    let offset = 0;
    let pages = 0;
    do {
      const page = readSkillInventoryPage(original, offset, String);
      expect(JSON.stringify(page).length).toBeLessThan(20_000);
      if (pages === 0)
        expect(page.limits).toEqual([expect.objectContaining({ reason: "description-capped-at-160", count: 128 })]);
      else expect(Object.keys(page).sort()).toEqual(page.nextCursor ? ["nextCursor", "units"] : ["units"]);
      ids.push(...page.units.map((unit) => unit.id));
      pages++;
      offset = page.nextCursor ? Number(page.nextCursor) : original.units.length;
    } while (offset < original.units.length);
    expect(ids).toEqual(original.units.map((unit) => unit.id));
    expect(pages).toBeLessThanOrEqual(3);
  });
  it("groups all identity kinds for one name without losing copy pairs or hashes", () => {
    const project = { ...unit(0), name: "review" };
    const marketplace = {
      ...unit(1),
      name: "review",
      scope: "marketplace",
      origin: { kind: "marketplace" as const, sourceId: "source", packageId: "package" },
    };
    const identity = deriveSkillInventoryIdentity([project, marketplace], []);
    expect(identity.byName).toEqual([
      {
        name: "review",
        kinds: ["sameNameDifferentContent", "unlinkedCopies", "multipleSources"],
        units: [project.id, marketplace.id],
        hashes: { [project.id]: project.contentHash, [marketplace.id]: marketplace.contentHash },
        unlinkedCopies: [{ project: project.id, marketplace: marketplace.id }],
      },
    ]);
  });
  it("rejects a relative path outside its registered root and invalid cursor positions", () => {
    expect(() => compactSkillInventoryUnit({ ...unit(0), skillMdPath: "/tmp/other/SKILL.md" }, scope)).toThrow(
      "outside scope",
    );
    for (const offset of [-1, 2, 0.5])
      expect(() => readSkillInventoryPage(snapshot([unit(0)]), offset, String)).toThrow("cursor position");
  });
});
