import { describe, expect, it, vi } from "vitest";
import { createSkillInventoryPages } from "../../src/main/agent-gateway/skill-inventory-pages";
import type { SkillInventorySnapshot } from "../../src/shared/skill-inventory";

function snapshot(): SkillInventorySnapshot {
  return {
    status: "ready",
    scopes: [{ key: "p0", kind: "project", projectId: "project", name: "Fixture", root: "/tmp/fixture" }],
    units: Array.from({ length: 111 }, (_, index) => ({
      id: `u${index}`,
      name: `skill-${index}`,
      scope: "p0",
      path: `.agents/skills/skill-${index}/SKILL.md`,
      description: "x".repeat(160),
      lines: 12,
      hash: "a".repeat(12),
    })),
    identity: {
      byName: [],
      sameContentDifferentNames: [],
      staleBindings: [],
    },
    unavailable: [],
    limits: [],
  };
}
describe("inventory cursor lifecycle", () => {
  it("reuses an immutable observation when resuming or replaying a page", async () => {
    const read = vi.fn(async () => snapshot());
    const inventory = createSkillInventoryPages(read);
    const first = await inventory({ projectIds: ["project"], includeMarketplace: false });
    expect(first.nextCursor).toBeDefined();
    const next = await inventory({ cursor: first.nextCursor });
    expect(await inventory({ cursor: first.nextCursor })).toEqual(next);
    expect([...first.units, ...next.units]).toHaveLength(111);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("rejects scope changes, invented cursor offsets, and expired observations without rescanning", async () => {
    const read = vi.fn(async () => snapshot());
    let now = 0;
    const inventory = createSkillInventoryPages(read, () => now);
    const first = await inventory({ projectIds: ["project"], includeMarketplace: false });
    for (const params of [
      { cursor: first.nextCursor, projectIds: ["other"] },
      { cursor: first.nextCursor, includeMarketplace: true },
      { cursor: first.nextCursor!.replace(/:\d+$/u, ":1") },
      { cursor: "invented" },
      { cursor: 2 },
    ])
      await expect(inventory(params)).rejects.toThrow();
    now = 5 * 60 * 1000;
    await expect(inventory({ cursor: first.nextCursor })).rejects.toThrow("expired");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("bounds cached snapshots and explicitly expires an evicted cursor", async () => {
    const inventory = createSkillInventoryPages(async () => snapshot());
    const first = await inventory({});
    for (let index = 0; index < 8; index++) await inventory({});
    await expect(inventory({ cursor: first.nextCursor })).rejects.toThrow("expired");
  });
});
