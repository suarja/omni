import { cp, rm, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalLibraryService } from "../../src/main/external-library/service";
import { externalLibraryFixture, fingerprint, E1_TIME } from "../helpers/external-library-fixture";
import { git, write } from "../helpers/publication-fixture";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("external library source checks", () => {
  it("detects prototype-sensitive lock keys and classifies their external uses", async () => {
    const f = await externalLibraryFixture();
    roots.push(f.root);
    const lock = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8"));
    const current = lock.skills.current;
    for (const skillKey of ["__proto__", "constructor", "prototype"]) {
      await cp(join(f.projectA, ".agents/skills/current"), join(f.projectA, `.agents/skills/${skillKey}`), {
        recursive: true,
      });
      Object.defineProperty(lock.skills, skillKey, {
        configurable: true,
        enumerable: true,
        value: { ...current, skillPath: "skills/current" },
        writable: true,
      });
    }
    await write(f.projectA, "skills-lock.json", JSON.stringify(lock));

    const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    await service.check();
    const source = await service.readSource("fixture/tools");
    expect(source.uses.filter((use) => ["__proto__", "constructor", "prototype"].includes(use.skillKey))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillKey: "__proto__", state: "up-to-date" }),
        expect.objectContaining({ skillKey: "constructor", state: "up-to-date" }),
        expect.objectContaining({ skillKey: "prototype", state: "up-to-date" }),
      ]),
    );
  }, 60000);

  it("detects locks, catalogs sources, recovers bases, and preserves every project and Claude file", async () => {
    const f = await externalLibraryFixture();
    roots.push(f.root);
    const before = await Promise.all([f.projectA, f.projectB, f.home, f.folderSource].map(fingerprint));
    const service = createExternalLibraryService({
      userDataPath: f.data,
      homeDir: f.home,
      resolveUrl: f.resolveUrl,
      now: () => Date.parse(E1_TIME),
    });
    const pass = await service.check();
    expect(pass.result).toBe("success");
    expect((await service.readSource("fixture/other")).source?.arrival).toBe("detected");
    const added = await service.add("https://github.com/fixture/other.git");
    expect(added.source?.licence).toBe("Apache-2.0");
    expect(added.source?.arrival).toBe("owner");
    expect(added.uses[0]).toMatchObject({ skillKey: "other", skillPath: "nested/other", state: "up-to-date" });
    expect(added.marketplaceMatches.map((m) => m.id)).toEqual(["other"]);
    const view = await service.list();
    expect(view.sources).toHaveLength(3);
    const source = await service.readSource("fixture/tools");
    expect(source.source?.licence).toBe("MIT");
    expect(source.skills.find((s) => s.name === "update")?.description).toBe("Latest upstream.");
    expect(source.uses.map((u) => [u.skillKey, u.state])).toEqual([
      ["current", "up-to-date"],
      ["removed", "removed"],
      ["update", "update"],
      ["modified", "modified"],
      ["not-found", "modified"],
    ]);
    const removed = source.uses.find((u) => u.skillKey === "removed")!;
    expect(removed.removal).toMatchObject({ commit: f.removalCommit, subject: "Remove retired skill" });
    expect(removed.removal?.date).toMatch(/^\d{4}-/u);
    const modified = source.uses.find((u) => u.skillKey === "modified")!;
    expect(modified.sourceChanged).toBe(true);
    expect(modified.base.status).toBe("unknown");
    expect((await service.compare(source.uses.find((u) => u.skillKey === "not-found")!.id)).base.status).toBe(
      "not-found",
    );
    const comparison = await service.compare(modified.id);
    expect(comparison.status).toBe("ready");
    expect(comparison.base).toMatchObject({ status: "found", commit: f.baseCommit });
    expect(comparison.files.find((file) => file.path === "SKILL.md")).toMatchObject({
      classification: "conflict",
      base: { text: expect.stringContaining("Base modified") },
      copy: { text: expect.stringContaining("Local.") },
      source: { text: expect.stringContaining("Upstream.") },
    });
    expect(comparison.files.find((file) => file.path === "binary.bin")?.base?.binary).toBe(true);
    expect(view.sources.find((s) => s.id === "fixture/tools")?.counts).toMatchObject({
      "up-to-date": 1,
      update: 1,
      modified: 2,
      removed: 1,
      unknown: 0,
    });
    expect(source.skills.filter((skill) => !skill.useIds.length).map((skill) => skill.name)).toEqual(["unused"]);
    expect((await service.onMac()).marketplaces).toHaveLength(2);
    expect(await Promise.all([f.projectA, f.projectB, f.home, f.folderSource].map(fingerprint))).toEqual(before);
    expect((await service.list()).lastPass).toEqual(pass);
    const reopened = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    expect((await reopened.list()).sources.find((s) => s.id === "fixture/other")?.arrival).toBe("owner");
  }, 60000);
  it("reads only known_marketplaces.json through the packaged fake-home seam", async () => {
    const f = await externalLibraryFixture();
    roots.push(f.root);
    const adapter = await import("../../src/adapters/inventory/local-filesystem");
    const original = adapter.createLocalInventoryPort,
      reads: string[] = [];
    const spy = vi.spyOn(adapter, "createLocalInventoryPort").mockImplementation((root, options) => {
      expect(root).toBe(f.home);
      const filesystem = original(root, options);
      return {
        ...filesystem,
        readText: async (path) => {
          reads.push(path);
          return filesystem.readText(path);
        },
      };
    });
    try {
      const { readExternalSourcesOnMac } = await import("../../src/main/external-library/detection");
      expect((await readExternalSourcesOnMac({ homeDir: f.home, isPackaged: true })).marketplaces).toHaveLength(2);
      expect(reads).toEqual([".claude/plugins/known_marketplaces.json"]);
    } finally {
      spy.mockRestore();
    }
  }, 60000);
  it("keeps cached skills visible while failed refreshes make uses unknown", async () => {
    const f = await externalLibraryFixture();
    roots.push(f.root);
    const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    await service.check();
    await rm(f.origin, { recursive: true, force: true });
    expect((await service.check()).result).toBe("partial");
    const source = await service.readSource("fixture/tools");
    expect(source.source?.lastError?.type).toBe("not-found");
    expect(source.skills).toHaveLength(4);
    expect(source.uses.every((use) => use.state === "unknown")).toBe(true);
    expect(source.skills.filter((skill) => !skill.useIds.length).map((skill) => skill.name)).toEqual(["unused"]);
    const added = await service.add("fixture/missing");
    expect(added.status).toBe("failed");
    expect(added.error?.type).toBe("not-found");
  }, 60000);
  it("withholds ambiguous, unsafe, and unhashable evidence rather than claiming removal", async () => {
    const f = await externalLibraryFixture();
    roots.push(f.root);
    await write(
      f.projectA,
      "skills-lock.json",
      JSON.stringify({
        version: 1,
        skills: { duplicate: { source: "fixture/tools", sourceType: "github", computedHash: "a".repeat(64) } },
      }),
    );
    await write(f.upstream, "a/duplicate/SKILL.md", "---\nname: duplicate\n---\n");
    await write(f.upstream, "b/duplicate/SKILL.md", "---\nname: duplicate\n---\n");
    const { commit } = await import("../helpers/publication-fixture");
    await commit(f.upstream);
    await git(f.upstream, "push", f.origin, "main");
    const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    await service.check();
    expect((await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "duplicate")?.state).toBe(
      "unknown",
    );
    await symlink(f.root, join(f.projectB, ".agents/skills/modified/escape"));
    await service.check();
    expect((await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "modified")?.state).toBe(
      "unknown",
    );
    expect(await readFile(join(f.home, ".claude/plugins/cache/private.txt"), "utf8")).toContain("Do not inspect");
  }, 60000);
  it("reports deletion of SKILL.md even when support files remain and bounds base recovery", async () => {
    const f = await externalLibraryFixture();
    roots.push(f.root);
    const { readExternalBase } = await import("../../src/main/external-library/use-reader");
    const modifiedHash = JSON.parse(await readFile(join(f.projectB, "skills-lock.json"), "utf8")).skills.modified
      .computedHash;
    expect(await readExternalBase(f.upstream, "skills/modified", modifiedHash, 1)).toMatchObject({
      status: "not-found",
      scanned: 1,
      bounded: true,
    });
    expect(await readExternalBase(f.projectA, "skills/modified", modifiedHash)).toMatchObject({ status: "unknown" });
    await git(f.upstream, "rm", "skills/modified/SKILL.md");
    const { commit } = await import("../helpers/publication-fixture");
    const deleting = await commit(f.upstream, "Retire modified entrypoint");
    await git(f.upstream, "push", f.origin, "main");
    const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    await service.check();
    const use = (await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "modified")!;
    expect(use.state).toBe("removed");
    expect(use.removal).toMatchObject({ commit: deleting, subject: "Retire modified entrypoint" });
  }, 60000);
  it("keeps a locally edited copy distinct from an unchanged source and rejects invalid Mac metadata safely", async () => {
    const f = await externalLibraryFixture();
    roots.push(f.root);
    await write(f.projectA, ".agents/skills/current/SKILL.md", "---\nname: current\n---\nEdited locally.\n");
    const service = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
    const before = await service.readSource("fixture/tools");
    expect(before.uses.every((use) => use.state === "unknown")).toBe(true);
    await service.check();
    expect((await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "current")).toMatchObject({
      state: "modified",
      sourceChanged: false,
      base: { status: "unknown" },
    });
    const current = (await service.readSource("fixture/tools")).uses.find((use) => use.skillKey === "current")!;
    expect((await service.compare(current.id)).base).toMatchObject({ status: "found" });
    await write(
      f.home,
      ".claude/plugins/known_marketplaces.json",
      JSON.stringify({ "unsafe\nname": { source: { source: "github", repo: "fixture/tools" } } }),
    );
    await service.check();
    await expect(service.onMac()).resolves.toMatchObject({
      status: "unavailable",
      marketplaces: [],
      error: { type: "other" },
    });
  }, 60000);
});
