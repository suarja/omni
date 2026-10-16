import { describe, expect, it } from "vitest";

import {
  buildCatalogueIndex,
  type CatalogueSnapshot,
  type MarketplaceSkillEntry,
} from "../../src/main/catalogue/index";
import { rank, type CatalogueEntry } from "../../src/main/catalogue/rank";
import type { StackProfile } from "../../src/domain/stack-profile";

function entry(overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
  return {
    source: "skills.sh",
    ownerRepo: "owner/repo",
    skill: "a-skill",
    name: "a-skill",
    path: "SKILL.md",
    tags: [],
    installs: 0,
    official: false,
    ...overrides,
  };
}

function profileWithTag(id: string, evidenceCount: number): StackProfile {
  return {
    tags: [{ id, label: id, evidence: Array.from({ length: evidenceCount }, (_, index) => `evidence-${index}`) }],
    languages: [],
    harnesses: [],
    computedAt: "2026-09-14T00:00:00.000Z",
    treeHash: "hash",
  };
}

type SnapshotEntryInput = Omit<CatalogueSnapshot["entries"][number], "source" | "weeklyInstalls" | "fetchedAt">;

function snapshotOf(entries: readonly SnapshotEntryInput[]): CatalogueSnapshot {
  return {
    builtAt: "2026-09-14T00:00:00.000Z",
    source: "skills.sh",
    entries: entries.map((item) => ({ source: "skills.sh" as const, weeklyInstalls: [], fetchedAt: "", ...item })),
  };
}

describe("rank", () => {
  it("ranks a matching entry above a merely popular one when a profile is given", () => {
    const matched = entry({ skill: "matched", name: "matched", tags: ["expo"], installs: 10 });
    const popular = entry({ skill: "popular", name: "popular", tags: [], installs: 1_000_000 });
    const profile = profileWithTag("expo", 2);
    const ranked = rank(profile, [matched, popular]);
    expect(ranked.map((result) => result.entry.skill)).toEqual(["matched", "popular"]);
    expect(ranked[0]!.matchedTags).toEqual(["expo"]);
  });

  it("weighs a specific tag (expo) above a broad one (typescript) whatever the evidence count", () => {
    const specific = entry({ skill: "specific", name: "specific", tags: ["expo"], installs: 1000 });
    const broad = entry({ skill: "broad", name: "broad", tags: ["typescript"], installs: 1000 });
    const profile = {
      ...profileWithTag("typescript", 6),
      tags: [...profileWithTag("typescript", 6).tags, ...profileWithTag("expo", 2).tags],
    };
    const ranked = rank(profile, [broad, specific]);
    expect(ranked.map((result) => result.entry.skill)).toEqual(["specific", "broad"]);
  });

  it("does not favor an unmatched tag over installs with no profile", () => {
    const low = entry({ skill: "low", name: "low", tags: ["react"], installs: 10 });
    const high = entry({ skill: "high", name: "high", tags: [], installs: 1_000_000 });
    const ranked = rank(null, [low, high]);
    expect(ranked.map((result) => result.entry.skill)).toEqual(["high", "low"]);
  });

  it("gives an official entry a bonus over an otherwise identical one", () => {
    const official = entry({ skill: "official-one", name: "official-one", installs: 1000, official: true });
    const unofficial = entry({ skill: "plain-one", name: "plain-one", installs: 1000, official: false });
    const ranked = rank(null, [official, unofficial]);
    expect(ranked.map((result) => result.entry.skill)).toEqual(["official-one", "plain-one"]);
  });

  it("keeps the marketplace entry for a duplicate name even when it scores lower", () => {
    const marketplaceVersion = entry({
      source: "marketplace",
      skill: "dup",
      name: "duplicate-skill",
      installs: 10,
      packageName: "my-plugin",
    });
    const skillsShVersion = entry({ source: "skills.sh", skill: "dup", name: "duplicate-skill", installs: 5_000_000 });
    const ranked = rank(null, [skillsShVersion, marketplaceVersion]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.entry.source).toBe("marketplace");
    expect(ranked[0]!.entry.packageName).toBe("my-plugin");
  });

  it("filters to entries matching the query and ranks a name match above a description-only match", () => {
    const nameMatch = entry({ skill: "name-match", name: "Frontend Design", installs: 1 });
    const descriptionMatch = entry({
      skill: "description-match",
      name: "other",
      description: "Guidance on frontend design choices.",
      installs: 1,
    });
    const noMatch = entry({ skill: "no-match", name: "unrelated", installs: 1_000_000 });
    const ranked = rank(null, [noMatch, descriptionMatch, nameMatch], "frontend design");
    expect(ranked.map((result) => result.entry.skill)).toEqual(["name-match", "description-match"]);
  });

  it("is pure and stable: the same input always returns the same order", () => {
    const entries = [entry({ skill: "a", name: "a", installs: 5 }), entry({ skill: "b", name: "b", installs: 5 })];
    const first = rank(null, entries).map((result) => result.entry.skill);
    const second = rank(null, entries).map((result) => result.entry.skill);
    expect(first).toEqual(second);
  });
});

describe("buildCatalogueIndex", () => {
  it("marks a snapshot entry as already in the marketplace when a skill of the same name is installed", () => {
    const snapshot = snapshotOf([
      {
        ownerRepo: "owner/repo",
        skill: "find-skills",
        name: "find-skills",
        path: "SKILL.md",
        tags: [],
        installs: 10,
        official: false,
      },
      {
        ownerRepo: "owner/repo",
        skill: "other",
        name: "other",
        path: "SKILL.md",
        tags: [],
        installs: 20,
        official: false,
      },
    ]);
    const installed: readonly MarketplaceSkillEntry[] = [{ name: "find-skills", packageName: "my-plugin" }];
    const index = buildCatalogueIndex(snapshot, installed);
    const found = index.find((item) => item.skill === "find-skills");
    const other = index.find((item) => item.skill === "other");
    expect(found?.source).toBe("marketplace");
    expect(found?.packageName).toBe("my-plugin");
    expect(other?.source).toBe("skills.sh");
  });

  it("matches names case-insensitively and trims whitespace", () => {
    const snapshot = snapshotOf([
      {
        ownerRepo: "owner/repo",
        skill: "Find-Skills",
        name: "  Find-Skills  ",
        path: "SKILL.md",
        tags: [],
        installs: 10,
        official: false,
      },
    ]);
    const installed: readonly MarketplaceSkillEntry[] = [{ name: "find-skills", packageName: "my-plugin" }];
    const index = buildCatalogueIndex(snapshot, installed);
    expect(index[0]?.source).toBe("marketplace");
  });

  it("leaves a marketplace skill with no matching snapshot entry out of the index entirely", () => {
    const snapshot = snapshotOf([]);
    const installed: readonly MarketplaceSkillEntry[] = [{ name: "only-local", packageName: "my-plugin" }];
    const index = buildCatalogueIndex(snapshot, installed);
    expect(index).toHaveLength(0);
  });
});
