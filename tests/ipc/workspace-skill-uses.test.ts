import { expect, it, vi } from "vitest";
import type { SkillRelationshipStore } from "../../src/ports/skill-reconciliation";
import { parseWorkspaceSkillUsesResponse } from "../../src/shared/workspace-skill-uses-ipc";

const use = {
  skillId: "11111111-1111-4111-8111-111111111111",
  bindingId: "use-1",
  source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
  location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/review" },
  baseRevisionId: "22222222-2222-4222-8222-222222222222",
};

it("rejects absolute paths and overlapping relationships at the renderer boundary", () => {
  expect(parseWorkspaceSkillUsesResponse({ status: "ready", uses: [use] })).toEqual({ status: "ready", uses: [use] });
  expect(() =>
    parseWorkspaceSkillUsesResponse({
      status: "ready",
      uses: [{ ...use, location: { ...use.location, folderPath: "/private/project/.agents/skills/review" } }],
    }),
  ).toThrow();
  expect(() =>
    parseWorkspaceSkillUsesResponse({ status: "ready", uses: [use, { ...use, bindingId: "use-2" }] }),
  ).toThrow("overlap");
  expect(() =>
    parseWorkspaceSkillUsesResponse({ status: "ready", uses: [], absoluteRoot: "/private/project" }),
  ).toThrow();
  expect(() => parseWorkspaceSkillUsesResponse({ status: "unavailable", uses: [] })).toThrow();
});

it("reads persisted workspace relationships without observing or mutating project files", async () => {
  const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<unknown>>();
  vi.doMock("electron", () => ({
    ipcMain: {
      handle: (channel: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(channel, handler),
    },
  }));
  const { registerSkillReconciliationIpcHandlers } = await import("../../src/main/skill-reconciliation/ipc");
  const store: SkillRelationshipStore = {
    read: vi.fn(async () => ({
      status: "ready" as const,
      state: { schemaVersion: 1 as const, revision: 0, skills: [], uses: [] },
    })),
    compareAndSave: vi.fn(),
    updateUsesExact: vi.fn(),
  };
  const trusted = vi.fn();
  const observe = vi.fn();
  registerSkillReconciliationIpcHandlers(trusted, { observeEntryWithGrant: observe } as never, {
    userDataPath: "/unused",
    store,
  });
  const handler = handlers.get("omni:skills:workspace-uses");
  expect(handler).toBeDefined();
  await expect(handler!({})).resolves.toEqual({ status: "ready", uses: [] });
  expect(trusted).toHaveBeenCalledTimes(1);
  expect(observe).not.toHaveBeenCalled();
  expect(store.compareAndSave).not.toHaveBeenCalled();
  expect(store.updateUsesExact).not.toHaveBeenCalled();
  await expect(handler!({}, { root: "/private/project" })).rejects.toThrow("do not accept");
  expect(store.read).toHaveBeenCalledTimes(1);
  vi.mocked(store.read).mockRejectedValueOnce(new Error("Unreadable relationship store"));
  await expect(handler!({})).resolves.toEqual({ status: "unavailable" });
});
