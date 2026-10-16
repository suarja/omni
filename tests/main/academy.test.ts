import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { academySummary, loadAcademyScreenshot, loadAcademySnapshot, readFirstLaunch } from "../../src/main/academy";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Academy main services", () => {
  it("loads the bundled snapshot and filters lessons by language", async () => {
    const snapshot = await loadAcademySnapshot({ appPath: process.cwd() });
    expect(snapshot.lessons.length).toBeGreaterThan(0);
    expect(snapshot.lessons.every((lesson) => lesson.lang === "en" || lesson.lang === "fr")).toBe(true);
    expect(
      academySummary(snapshot, "en").find((lesson) => lesson.slug === "skills-plugins-marketplaces"),
    ).not.toHaveProperty("body");
  });

  it("creates first-launch.json on first read and reuses its installed date", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omni-academy-"));
    temporaryDirectories.push(directory);
    const first = await readFirstLaunch(directory, () => "2026-09-15T12:00:00.000Z");
    expect(first).toEqual({ installedAt: "2026-09-15T12:00:00.000Z" });
    expect(await readFile(join(directory, "omni", "first-launch.json"), "utf8")).toContain("2026-09-15T12:00:00.000Z");
    expect(await readFirstLaunch(directory, () => "2026-09-16T12:00:00.000Z")).toEqual(first);
  });

  it("loads an existing PNG screenshot and reports a missing one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omni-academy-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "resources", "academy"), { recursive: true });
    await writeFile(
      join(directory, "resources", "academy", "library-marketplace.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(await loadAcademyScreenshot("library-marketplace", { appPath: directory })).toEqual({
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(await loadAcademyScreenshot("missing-shot", { appPath: directory })).toEqual({ status: "missing" });
  });

  it("rejects a non-PNG or oversized screenshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omni-academy-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "resources", "academy"), { recursive: true });
    await writeFile(join(directory, "resources", "academy", "not-png.png"), Buffer.from("not png"));
    await writeFile(join(directory, "resources", "academy", "too-large.png"), Buffer.alloc(1_500_001));
    await expect(loadAcademyScreenshot("not-png", { appPath: directory })).rejects.toThrow("PNG");
    await expect(loadAcademyScreenshot("too-large", { appPath: directory })).rejects.toThrow("size limit");
  });
});
