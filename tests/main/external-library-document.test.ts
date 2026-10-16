import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { externalOperationFixture } from "../helpers/external-operations-fixture";
import { fingerprint } from "../helpers/external-library-fixture";
import { createExternalLibraryUiAdapter } from "../../src/main/external-library/ui-adapter";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: true, getPath: () => "/unused" },
  dialog: {},
}));

it("reads an offline cached document while source import, installation and updates stay blocked", async () => {
  const f = await externalOperationFixture();
  await rename(f.origin, join(f.root, "offline.git"));
  await f.library.check();
  const details = await f.library.readSource("fixture/tools");
  expect(details.source?.lastError).toBeDefined();
  const before = await Promise.all([fingerprint(f.projectA), fingerprint(f.projectB), fingerprint(f.home)]);
  const adapter = createExternalLibraryUiAdapter({
    library: f.library,
    grants: f.registry,
    openRepository: vi.fn(async () => {}),
  });
  const result = await adapter.readDocument({ sourceId: "fixture/tools", skillPath: "skills/unused" });
  expect(result).toEqual(expect.objectContaining({ status: "read", content: expect.stringContaining("Base unused.") }));
  await expect(adapter.importSource({ sourceId: "fixture/tools", skillPath: "skills/unused" })).rejects.toThrow(
    "Check the library",
  );
  const removed = details.uses.find((use) => use.skillKey === "update")!;
  for (const intent of [
    {
      kind: "install-external-skill" as const,
      sourceId: "fixture/tools",
      skillPath: "skills/unused",
      skillName: "unused",
      conflict: "refuse" as const,
      targets: [{ projectId: "project-a", harnessIds: ["codex" as const] }],
    },
    { kind: "update-external-skills" as const, sourceId: "fixture/tools", useIds: [removed.id] },
  ]) {
    expect((await f.service.preview(intent, { kind: "desktop" })).status).toBe("blocked");
  }
  await expect(adapter.readDocument({ sourceId: "fixture/tools", skillPath: "skills/not-checked" })).rejects.toThrow();
  await expect(adapter.readDocument({ sourceId: "fixture/tools", skillPath: "../private" })).rejects.toThrow();
  expect(await Promise.all([fingerprint(f.projectA), fingerprint(f.projectB), fingerprint(f.home)])).toEqual(before);
  const observation = await f.library.operationObservation();
  await rm(observation.roots.get("fixture/tools")!, { recursive: true });
  await expect(adapter.readDocument({ sourceId: "fixture/tools", skillPath: "skills/unused" })).rejects.toThrow();
}, 20000);
