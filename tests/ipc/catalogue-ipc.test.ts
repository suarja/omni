import { describe, expect, it } from "vitest";

import {
  parseCatalogueEntryRequest,
  parseCatalogueEntryResponse,
  parseCataloguePrepareImportRequest,
  parseCataloguePrepareImportResponse,
  parseCatalogueSearchRequest,
  parseCatalogueSearchResponse,
} from "../../src/shared/catalogue-ipc";

describe("parseCatalogueSearchRequest", () => {
  it("accepts an empty request", () => {
    expect(parseCatalogueSearchRequest({})).toEqual({});
  });

  it("accepts query, tags, projectId, and limit together", () => {
    expect(
      parseCatalogueSearchRequest({ query: " react ", tags: ["react", "next"], projectId: "proj-1", limit: 10 }),
    ).toEqual({ query: "react", tags: ["react", "next"], projectId: "proj-1", limit: 10 });
  });

  it("rejects an unexpected field", () => {
    expect(() => parseCatalogueSearchRequest({ bogus: true })).toThrow();
  });

  it("rejects a limit over 100", () => {
    expect(() => parseCatalogueSearchRequest({ limit: 101 })).toThrow();
  });

  it("rejects a limit of zero or a non-integer", () => {
    expect(() => parseCatalogueSearchRequest({ limit: 0 })).toThrow();
    expect(() => parseCatalogueSearchRequest({ limit: 1.5 })).toThrow();
  });

  it("rejects more than 20 tags", () => {
    const tags = Array.from({ length: 21 }, (_, index) => `tag-${index}`);
    expect(() => parseCatalogueSearchRequest({ tags })).toThrow();
  });

  it("rejects duplicate tags", () => {
    expect(() => parseCatalogueSearchRequest({ tags: ["react", "react"] })).toThrow();
  });

  it("rejects a malformed tag id", () => {
    expect(() => parseCatalogueSearchRequest({ tags: ["Not-Kebab"] })).toThrow();
  });

  it("rejects a query over the length bound", () => {
    expect(() => parseCatalogueSearchRequest({ query: "x".repeat(201) })).toThrow();
  });
});

const validEntryView = {
  source: "skills.sh" as const,
  ownerRepo: "owner/repo",
  skill: "a-skill",
  name: "a-skill",
  hasSkillMd: true,
  tags: ["react"],
  installs: 42,
  official: true,
};

describe("parseCatalogueSearchResponse", () => {
  it("round-trips a ready response with results", () => {
    const response = {
      status: "ready" as const,
      results: [{ entry: validEntryView, score: 12.5, matchedTags: ["react"] }],
    };
    expect(parseCatalogueSearchResponse(response)).toEqual(response);
  });

  it("accepts an empty results list", () => {
    expect(parseCatalogueSearchResponse({ status: "ready", results: [] })).toEqual({ status: "ready", results: [] });
  });

  it("rejects an invalid entry source", () => {
    expect(() =>
      parseCatalogueSearchResponse({
        status: "ready",
        results: [{ entry: { ...validEntryView, source: "bogus" }, score: 1, matchedTags: [] }],
      }),
    ).toThrow();
  });

  it("rejects a non-finite score", () => {
    expect(() =>
      parseCatalogueSearchResponse({
        status: "ready",
        results: [{ entry: validEntryView, score: NaN, matchedTags: [] }],
      }),
    ).toThrow();
  });
});

describe("parseCatalogueEntryRequest", () => {
  it("accepts a well-formed owner/repo and skill id", () => {
    expect(parseCatalogueEntryRequest({ ownerRepo: "vercel-labs/skills", skill: "find-skills" })).toEqual({
      ownerRepo: "vercel-labs/skills",
      skill: "find-skills",
    });
  });

  it("rejects an owner/repo without a slash", () => {
    expect(() => parseCatalogueEntryRequest({ ownerRepo: "not-a-pair", skill: "x" })).toThrow();
  });

  it("rejects a path-traversal owner/repo", () => {
    expect(() => parseCatalogueEntryRequest({ ownerRepo: "../etc/passwd", skill: "x" })).toThrow();
  });
});

describe("parseCatalogueEntryResponse", () => {
  it("round-trips a not-found response", () => {
    expect(parseCatalogueEntryResponse({ status: "not-found" })).toEqual({ status: "not-found" });
  });

  it("round-trips a ready response with a ready SKILL.md", () => {
    const response = {
      status: "ready" as const,
      entry: validEntryView,
      skillMd: { status: "ready" as const, content: "# Hi" },
    };
    expect(parseCatalogueEntryResponse(response)).toEqual(response);
  });

  it("round-trips the honest offline state", () => {
    const response = { status: "ready" as const, entry: validEntryView, skillMd: { status: "offline" as const } };
    expect(parseCatalogueEntryResponse(response)).toEqual(response);
  });

  it("round-trips the unavailable state with a reason", () => {
    const response = {
      status: "ready" as const,
      entry: validEntryView,
      skillMd: { status: "unavailable" as const, reason: "No SKILL.md was found for this skill." },
    };
    expect(parseCatalogueEntryResponse(response)).toEqual(response);
  });

  it("rejects an invalid skillMd status", () => {
    expect(() =>
      parseCatalogueEntryResponse({ status: "ready", entry: validEntryView, skillMd: { status: "bogus" } }),
    ).toThrow();
  });
});

describe("parseCataloguePrepareImportRequest / Response", () => {
  it("round-trips a prepare-import request", () => {
    expect(parseCataloguePrepareImportRequest({ ownerRepo: "owner/repo", skill: "a-skill" })).toEqual({
      ownerRepo: "owner/repo",
      skill: "a-skill",
    });
  });

  it("round-trips a ready prepare-import response", () => {
    const response = {
      status: "ready" as const,
      sourceId: "catalogue-abc123",
      grantHandle: "handle-1",
      relativePath: "skills/a-skill/SKILL.md",
    };
    expect(parseCataloguePrepareImportResponse(response)).toEqual(response);
  });

  it("round-trips the offline and unavailable prepare-import states", () => {
    expect(parseCataloguePrepareImportResponse({ status: "offline" })).toEqual({ status: "offline" });
    expect(
      parseCataloguePrepareImportResponse({ status: "unavailable", reason: "No SKILL.md was found for this skill." }),
    ).toEqual({
      status: "unavailable",
      reason: "No SKILL.md was found for this skill.",
    });
  });

  it("rejects a grant handle that is not opaque", () => {
    expect(() =>
      parseCataloguePrepareImportResponse({
        status: "ready",
        sourceId: "catalogue-abc123",
        grantHandle: "../etc/passwd",
        relativePath: "skills/a-skill/SKILL.md",
      }),
    ).toThrow();
  });

  it("rejects an absolute relative path", () => {
    expect(() =>
      parseCataloguePrepareImportResponse({
        status: "ready",
        sourceId: "catalogue-abc123",
        grantHandle: "handle-1",
        relativePath: "/etc/passwd",
      }),
    ).toThrow();
  });
});
