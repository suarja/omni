import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("storefront publication contracts", () => {
  it("treats inherited object names as ordinary added file paths", async () => {
    const { classifyPublicationDrift } = await import("../../src/domain/publication-drift");
    expect(classifyPublicationDrift({}, {}, { constructor: "hash" }).files).toEqual([
      { path: "constructor", classification: "added-in-workshop" },
    ]);
  });
  it("reads the real workshop origin format and safe GitHub remote variants", async () => {
    const { parseOriginRecord, githubRepository } = await import("../../src/domain/storefront-origin");
    const origin = parseOriginRecord(
      readFileSync(new URL("../fixtures/storefront-origin.md", import.meta.url), "utf8"),
    );
    expect(origin).toEqual({
      sourceRepository: "acme/claude-plugins",
      sourcePath: "packages/explainer-motion",
      sourceCommit: "1a319fb",
      publishedTime: "2026-10-11T00:00:00.000Z",
    });
    for (const remote of [
      "git@github.com:acme/claude-plugins.git",
      "https://github.com/acme/claude-plugins.git",
      "ssh://git@github.com/acme/claude-plugins",
    ])
      expect(githubRepository(remote)).toBe("acme/claude-plugins");
    expect(githubRepository("https://example.com/acme/claude-plugins")).toBeUndefined();
    expect(parseOriginRecord("- Source path: ../../outside")).toBeUndefined();
  });
  it("classifies all six file states and excludes workshop metadata", async () => {
    const { classifyPublicationDrift } = await import("../../src/domain/publication-drift");
    const base = { same: "a", workshop: "a", storefront: "a", conflict: "a", removed: "a", "omni.plugin.json": "a" };
    const storefront = { ...base, storefront: "b", conflict: "b" };
    const workshop = { same: "a", workshop: "b", storefront: "a", conflict: "c", added: "b", "omni.plugin.json": "c" };
    const drift = classifyPublicationDrift(base, storefront, workshop);
    expect(Object.fromEntries(drift.files.map((file) => [file.path, file.classification]))).toEqual({
      same: "unchanged",
      workshop: "workshop-changed",
      storefront: "storefront-only",
      conflict: "conflict",
      added: "added-in-workshop",
      removed: "removed-in-workshop",
    });
    expect(drift).toMatchObject({ behind: true, toPublish: 3, conflicts: 1 });
  });
  it("keeps identical edits and storefront additions and detects delete/edit conflicts", async () => {
    const { classifyPublicationDrift } = await import("../../src/domain/publication-drift");
    expect(
      classifyPublicationDrift({ equal: "a", deleted: "a" }, { equal: "b", deleted: "b", local: "b" }, { equal: "b" })
        .files,
    ).toEqual([
      { path: "deleted", classification: "conflict" },
      { path: "equal", classification: "unchanged" },
      { path: "local", classification: "storefront-only" },
    ]);
  });
  it("strictly validates versioned publications including safe file paths", async () => {
    const { parsePublicationsState } = await import("../../src/domain/publications");
    const record = {
      storefrontSourceId: "storefront",
      pluginId: "demo",
      workshopPackagePath: "packages/demo",
      baseCommit: "abcdef1",
      publishedHashes: { "SKILL.md": "a".repeat(64) },
      storefrontCommit: "abcdef2",
      publishedTime: "2026-10-12T10:00:00.000Z",
    };
    expect(parsePublicationsState({ schemaVersion: 1, publications: [record] }).publications).toEqual([record]);
    for (const bad of [
      { ...record, extra: true },
      { ...record, baseCommit: "HEAD~1" },
      { ...record, workshopPackagePath: "../outside" },
      { ...record, publishedHashes: { "../outside": "a".repeat(64) } },
    ])
      expect(() => parsePublicationsState({ schemaVersion: 1, publications: [bad] })).toThrow();
    expect(() => parsePublicationsState({ schemaVersion: 2, publications: [] })).toThrow();
    expect(() => parsePublicationsState({ schemaVersion: 1, publications: [record, record] })).toThrow();
    const namedHashes = Object.fromEntries([
      ["__proto__", "a".repeat(64)],
      ["constructor", "b".repeat(64)],
    ]);
    expect(
      parsePublicationsState({ schemaVersion: 1, publications: [{ ...record, publishedHashes: namedHashes }] })
        .publications[0]!.publishedHashes,
    ).toEqual(namedHashes);
  });
});
