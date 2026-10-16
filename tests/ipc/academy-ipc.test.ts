import { describe, expect, it } from "vitest";

import {
  parseAcademyFirstLaunchResponse,
  parseAcademyLessonRequest,
  parseAcademyLessonResponse,
  parseAcademyListRequest,
  parseAcademyListResponse,
  parseAcademyScreenshotRequest,
  parseAcademyScreenshotResponse,
  splitLessonBody,
} from "../../src/shared/academy-ipc";

const lesson = {
  lang: "en" as const,
  kind: "tutorial" as const,
  slug: "connect-your-marketplace",
  title: "Connect your marketplace",
  summary: "Make a local marketplace available to Omni.",
  minutes: 4,
  products: ["claude-code", "codex"] as const,
  illustration: "marketplace",
  topic: "marketplaces",
  cta: { route: "library-add" as const, label: "Open Library" },
  steps: ["1. Open Library", "2. Choose a local marketplace", "3. Confirm the connection"] as const,
  body: "## 1. Open Library\n\nStart in Library.",
};

describe("Academy IPC parsers", () => {
  it("accepts the strict list and lesson requests", () => {
    expect(parseAcademyListRequest({ lang: "fr" })).toEqual({ lang: "fr" });
    expect(parseAcademyLessonRequest({ lang: "en", kind: "tutorial", slug: "connect-your-marketplace" })).toEqual({
      lang: "en",
      kind: "tutorial",
      slug: "connect-your-marketplace",
    });
  });

  it("rejects unknown fields and malformed lesson requests", () => {
    expect(() => parseAcademyListRequest({ lang: "en", extra: true })).toThrow();
    expect(() => parseAcademyLessonRequest({ lang: "en", kind: "course", slug: "../secret" })).toThrow();
  });

  it("round-trips list, lesson, and first-launch responses", () => {
    const { body: _body, ...summary } = lesson;
    expect(parseAcademyListResponse({ lessons: [summary] })).toEqual({ lessons: [summary] });
    expect(parseAcademyLessonResponse({ status: "ready", lesson })).toEqual({ status: "ready", lesson });
    expect(parseAcademyLessonResponse({ status: "not-found" })).toEqual({ status: "not-found" });
    expect(parseAcademyFirstLaunchResponse({ installedAt: "2026-09-15T00:00:00.000Z" })).toEqual({
      installedAt: "2026-09-15T00:00:00.000Z",
    });
  });

  it("rejects an unsafe first-launch response", () => {
    expect(() => parseAcademyFirstLaunchResponse({ installedAt: "not-a-date" })).toThrow();
  });

  it("keeps lesson bodies out of list responses", () => {
    const { body: _body, ...summary } = lesson;
    expect(() => parseAcademyListResponse({ lessons: [{ ...summary, body: "private body" }] })).toThrow();
  });

  it("splits a lesson body into Markdown and illustration blocks, keeping unknown markers as text", () => {
    expect(splitLessonBody("## 1\n\ntext\n\n[illustration:receipt]\n\n## 2\n\n[illustration:nope]\nmore")).toEqual([
      { kind: "markdown", source: "## 1\n\ntext\n" },
      { kind: "illustration", id: "receipt" },
      { kind: "markdown", source: "\n## 2\n\n[illustration:nope]\nmore" },
    ]);
  });

  it("parses bounded screenshot requests and PNG responses", () => {
    expect(parseAcademyScreenshotRequest({ name: "library-marketplace" })).toEqual({ name: "library-marketplace" });
    expect(parseAcademyScreenshotResponse({ dataUrl: "data:image/png;base64,AAAA" })).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
    });
    expect(parseAcademyScreenshotResponse({ status: "missing" })).toEqual({ status: "missing" });
  });

  it("rejects unsafe screenshot names and non-PNG responses", () => {
    expect(() => parseAcademyScreenshotRequest({ name: "../secret" })).toThrow();
    expect(() => parseAcademyScreenshotRequest({ name: "UPPER_CASE" })).toThrow();
    expect(() => parseAcademyScreenshotRequest({ name: "a".repeat(81) })).toThrow();
    expect(() => parseAcademyScreenshotResponse({ dataUrl: "data:image/jpeg;base64,AAAA" })).toThrow();
    expect(() =>
      parseAcademyScreenshotResponse({ dataUrl: "data:image/png;base64," + "A".repeat(2_100_000) }),
    ).toThrow();
  });

  it("splits screenshot markers separately from illustration markers", () => {
    expect(splitLessonBody("Before\n\n[screenshot:library-marketplace]\n\nAfter")).toEqual([
      { kind: "markdown", source: "Before\n" },
      { kind: "screenshot", name: "library-marketplace" },
      { kind: "markdown", source: "\nAfter" },
    ]);
  });
});
