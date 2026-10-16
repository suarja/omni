import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { externalLibraryFixture, fingerprint } from "../helpers/external-library-fixture";
import { createExternalLibraryService } from "../../src/main/external-library/service";
import { createExternalLibraryUiAdapter } from "../../src/main/external-library/ui-adapter";
import { externalOperationFixture } from "../helpers/external-operations-fixture";
const roots: string[] = [];
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: true, getPath: () => "/unused" },
  dialog: {},
}));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("discovers GitHub licence and skills without adding a source or writing projects or the agent home", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  const library = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  const before = await Promise.all([
    fingerprint(f.projectA),
    fingerprint(f.projectB),
    fingerprint(f.home),
    readFile(join(f.data, "omni/project-source-registry.json"), "utf8"),
  ]);
  const adapter = createExternalLibraryUiAdapter({
    library,
    grants: { issue: vi.fn(), get: vi.fn() },
    resolveUrl: f.resolveUrl,
    openRepository: vi.fn(async () => {}),
  });
  const found = await adapter.discover("fixture/tools");
  expect(found.status, JSON.stringify(found)).toBe("ready");
  if (found.status !== "ready") throw new Error("Discovery unavailable");
  expect(found.source.licence).toBe("MIT");
  expect(found.skills.some((skill) => skill.name === "unused")).toBe(true);
  expect(found.marketplaceMatches).toEqual([{ id: "tools", repo: "fixture/tools" }]);
  await expect(readFile(join(f.data, "omni/external-sources.json"))).rejects.toThrow();
  expect(
    await Promise.all([
      fingerprint(f.projectA),
      fingerprint(f.projectB),
      fingerprint(f.home),
      readFile(join(f.data, "omni/project-source-registry.json"), "utf8"),
    ]),
  ).toEqual(before);
  expect(await adapter.discover("https://github.com/fixture/tools")).toEqual(found);
}, 20000);
it("returns a visible discovery failure and never opens a renderer-supplied URL", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  const library = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  const open = vi.fn(async () => {});
  const adapter = createExternalLibraryUiAdapter({
    library,
    grants: { issue: vi.fn(), get: vi.fn() },
    resolveUrl: f.resolveUrl,
    openRepository: open,
  });
  expect((await adapter.discover("fixture/missing")).status).toBe("failed");
  await expect(adapter.discover("https://token@github.com/fixture/tools")).rejects.toThrow();
  expect((await adapter.openRepository("https://untrusted.example")).status).toBe("blocked");
  expect(open).not.toHaveBeenCalled();
  await library.check();
  await adapter.openRepository("fixture/tools");
  expect(open).toHaveBeenCalledWith("https://github.com/fixture/tools");
}, 20000);
it("copies an unused checked source through ordinary import, records the repository and supports Undo", async () => {
  const f = await externalOperationFixture();
  const personal = join(f.root, "personal");
  await mkdir(personal);
  expect((await f.registry.registerSourceByPath(personal, "Personal")).status).toBe("ready");
  const adapter = createExternalLibraryUiAdapter({
    library: f.library,
    grants: f.registry,
    openRepository: vi.fn(async () => {}),
  });
  const prepared = await adapter.importSource({ sourceId: "fixture/tools", skillPath: "skills/unused" });
  const before = await fingerprint(f.projectA);
  const preview = await f.operations.previewOperation({
    kind: "import-artifact",
    source: { kind: prepared.kind, id: prepared.id, grantHandle: prepared.grantHandle },
    relativePath: prepared.relativePath,
    target: { newPackageName: "external-tools", description: "Skills copied from external sources." },
  });
  expect(preview.status, JSON.stringify(preview)).toBe("ready");
  if (preview.status !== "ready") throw new Error("Import unavailable");
  const result = await f.operations.applyOperation({ planId: preview.plan.planId });
  expect(result?.status).toBe("applied");
  expect(await readFile(join(personal, "packages/external-tools/omni.plugin.json"), "utf8")).toContain("fixture/tools");
  expect(await fingerprint(f.projectA)).toBe(before);
  const restore = await f.operations.previewOperation({
    kind: "restore-import",
    operationId: result!.receipt.operationId,
  });
  expect(restore.status, JSON.stringify(restore)).toBe("ready");
  if (restore.status !== "ready") throw new Error("Undo unavailable");
  expect((await f.operations.applyOperation({ planId: restore.plan.planId }))?.status).toBe("applied");
}, 20000);
it("rejects unknown paths and offline source imports before issuing any grant", async () => {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  const library = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  await library.check();
  const issue = vi.fn();
  const adapter = createExternalLibraryUiAdapter({
    library,
    grants: { issue, get: vi.fn() },
    openRepository: vi.fn(async () => {}),
  });
  await expect(adapter.importSource({ sourceId: "fixture/tools", skillPath: "../../private" })).rejects.toThrow();
  await expect(adapter.importSource({ sourceId: "fixture/missing", skillPath: "skills/unused" })).rejects.toThrow();
  expect(issue).not.toHaveBeenCalled();
}, 20000);
