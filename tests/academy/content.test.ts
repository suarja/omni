import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import { academyCtaRoute } from "../../src/renderer/learn/LessonPage";
import { resolveCanvasRoute } from "../../src/renderer/canvas-route";
import type { AcademyCtaRoute } from "../../src/shared/academy-ipc";

type AcademySnapshot = {
  lessons: Array<{
    lang: "en" | "fr";
    kind: "course" | "tutorial" | "topic";
    slug: string;
    title: string;
    summary: string;
    minutes?: number;
    products: string[];
    illustration: string;
    topic: string;
    cta?: { route: string; label: string };
    steps?: string[];
    body: string;
  }>;
};

const snapshotPath = join(process.cwd(), "packages/omni-academy/academy.json");
const contentRoot = join(process.cwd(), "packages/omni-academy/content");
const shotsScriptPath = join(process.cwd(), "scripts/academy-shots.mjs");

async function snapshot(): Promise<AcademySnapshot> {
  return JSON.parse(await readFile(snapshotPath, "utf8")) as AcademySnapshot;
}

describe("Academy content package", () => {
  it("keeps EN and FR lesson twins with valid metadata", async () => {
    const data = await snapshot();
    const byKey = new Map(data.lessons.map((lesson) => [`${lesson.lang}/${lesson.kind}/${lesson.slug}`, lesson]));
    expect(data.lessons).toHaveLength(36);
    for (const lesson of data.lessons) {
      expect(byKey.has(`${lesson.lang}/${lesson.kind}/${lesson.slug}`)).toBe(true);
      expect(lesson.title).not.toBe("");
      expect(lesson.summary).not.toContain("\n");
      expect(["course", "tutorial", "topic"]).toContain(lesson.kind);
      expect(lesson.products).toEqual(["claude-code", "codex"]);
      if (lesson.kind === "tutorial") expect(lesson.minutes).toBe(4);
      if (lesson.steps) {
        expect(lesson.steps).toEqual([...lesson.body.matchAll(/^## (.+)$/gm)].map((match) => match[1]));
      }
    }
    for (const lang of ["en", "fr"] as const) {
      const twinLang = lang === "en" ? "fr" : "en";
      for (const lesson of data.lessons.filter((item) => item.lang === lang)) {
        expect(byKey.get(`${twinLang}/${lesson.kind}/${lesson.slug}`)).toBeDefined();
      }
    }
  });

  it("keeps every CTA on the approved navigation route list", async () => {
    const data = await snapshot();
    const routes = ["library-add", "agents-setup", "projects", "review", "library"];
    for (const lesson of data.lessons) {
      if (!lesson.cta) continue;
      expect(routes).toContain(lesson.cta.route);
      const route = academyCtaRoute(lesson.cta.route as AcademyCtaRoute);
      expect(resolveCanvasRoute(route), `${lesson.slug} CTA`).not.toBeNull();
    }
    expect(resolveCanvasRoute(academyCtaRoute("agents-setup"))?.initialRailSurface).toBe("settings");
    expect(resolveCanvasRoute(academyCtaRoute("library-add"))?.initialRailSurface).toBe("marketplace");
  });

  it("keeps deepened lessons within their line limits and gives every tutorial step a visual marker", async () => {
    const data = await snapshot();
    for (const lesson of data.lessons) {
      const lineCount = (
        await readFile(join(contentRoot, lesson.lang, lesson.kind, `${lesson.slug}.md`), "utf8")
      ).split("\n").length;
      // An upper bound only: a minimum line count would reward padding, not depth.
      expect(lineCount, `${lesson.lang}/${lesson.kind}/${lesson.slug}`).toBeLessThanOrEqual(150);
      if (lesson.kind !== "tutorial") continue;
      const blocks = lesson.body.split("\n");
      const headings = [...lesson.body.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
      expect(headings).toHaveLength(lesson.steps?.length ?? 0);
      for (const [index, heading] of headings.entries()) {
        const start = blocks.indexOf(`## ${heading}`);
        const next = index + 1 < headings.length ? blocks.indexOf(`## ${headings[index + 1]}`) : blocks.length;
        const section = blocks.slice(start, next).join("\n");
        expect(section).toMatch(/Ce que vous verrez|What you will see/);
        expect(section).toMatch(/\[(?:illustration|screenshot):[a-z0-9-]+\]/);
      }
      expect(lesson.body).toMatch(/(?:Et ensuite|Next)/);
    }
  });

  it("resolves academy links in both languages and lists every screenshot walk", async () => {
    const data = await snapshot();
    const keys = new Set(data.lessons.map((lesson) => `${lesson.kind}/${lesson.slug}`));
    const script = await readFile(shotsScriptPath, "utf8");
    const walkNames = new Set([...script.matchAll(/name:\s*["']([a-z0-9-]+)["']/g)].map((match) => match[1]));
    for (const lesson of data.lessons) {
      for (const match of lesson.body.matchAll(/academy:\/\/(course|tutorial|topic)\/([a-z0-9-]+)/g)) {
        expect(keys.has(`${match[1]}/${match[2]}`), `${relative(contentRoot, lesson.slug)} link`).toBe(true);
        const twin = data.lessons.find(
          (candidate) => candidate.lang !== lesson.lang && candidate.kind === match[1] && candidate.slug === match[2],
        );
        expect(twin).toBeDefined();
      }
      for (const match of lesson.body.matchAll(/\[screenshot:([a-z0-9-]+)\]/g)) {
        expect(walkNames.has(match[1]), `${lesson.slug} screenshot`).toBe(true);
      }
      if (lesson.kind === "topic") expect(lesson.body).toMatch(/^## (?:Dans Omni|In Omni)$/m);
    }
  });
});
