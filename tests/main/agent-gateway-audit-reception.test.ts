import { describe, expect, it } from "vitest";
import type { AgentSkillInventoryResponse } from "../../src/shared/skill-inventory";
import { fixture, FIXTURE_TIMEOUT_MS } from "./agent-gateway-audit-fixture";

describe("realistic audit reception", () => {
  it(
    "reaches all 128 long-description skills within three bounded pages without repeating metadata",
    async () => {
      const f = await fixture("realistic");
      const pages: AgentSkillInventoryResponse[] = [];
      let cursor: string | undefined;
      do {
        const page = (await f.router.handle("skill_inventory", cursor ? { cursor } : {}, {
          name: "test",
          version: "1",
        })) as AgentSkillInventoryResponse;
        expect(JSON.stringify(page).length).toBeLessThan(20_000);
        pages.push(page);
        cursor = page.nextCursor;
        expect(pages.length).toBeLessThanOrEqual(3);
      } while (cursor);
      const units = pages.flatMap((page) => page.units);
      expect(units).toHaveLength(128);
      expect(new Set(units.map((unit) => unit.id)).size).toBe(128);
      expect(units.every((unit) => unit.description?.length === 160)).toBe(true);
      const first = pages[0]!;
      expect(first.status).toBe("partial");
      expect(first.unavailable).toEqual([expect.objectContaining({ projectId: f.missingId, reason: "missing" })]);
      expect(first.limits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "description-capped-at-160", count: 128, examples: expect.any(Array) }),
        ]),
      );
      const cap = first.limits!.find((limit) => "count" in limit)!;
      if ("examples" in cap) expect(cap.examples).toHaveLength(3);
      for (const page of pages.slice(1))
        expect(Object.keys(page).sort()).toEqual(page.nextCursor ? ["nextCursor", "units"] : ["units"]);
      expect(new Set(first.identity!.byName.map((finding) => finding.name)).size).toBe(first.identity!.byName.length);
      for (const finding of first.identity!.byName) {
        expect(finding.units.every((id) => units.some((unit) => unit.id === id))).toBe(true);
        for (const [id, hash] of Object.entries(finding.hashes))
          expect(units.find((unit) => unit.id === id)?.hash).toBe(hash);
      }
      expect(f.observe.mock.calls.filter(([ref]) => ref.id === f.projectId)).toHaveLength(1);
      console.info(
        `Long-description reception page sizes: ${pages.map((page) => JSON.stringify(page).length).join(", ")}; ${units.length} units`,
      );
    },
    FIXTURE_TIMEOUT_MS,
  );
});
