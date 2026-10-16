import { expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, (event: unknown, request?: unknown) => Promise<unknown>>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, request?: unknown) => Promise<unknown>) =>
      ipcHandlers.set(channel, handler),
    ),
  },
}));

import { registerSkillManagementIpcHandlers } from "../../src/main/skill-management/ipc";
import type { SkillManagementService } from "../../src/application/skill-management";
import { SKILL_MANAGEMENT_IPC_CHANNELS } from "../../src/shared/skill-management-ipc";
import type { ReadSkillVariantOriginResponse } from "../../src/shared/skill-variant-effects";

const source = { sourceId: "source-one", packageId: "tools", artifactPath: "skills/demo-personal" };
const origin = {
  schemaVersion: 1,
  variantId: "123e4567-e89b-42d3-a456-426614174000",
  forkOf: "223e4567-e89b-42d3-a456-426614174000",
  capturedAt: "2026-10-09T10:00:00.000Z",
  capturedFrom: {
    location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" },
    revision: { algorithm: "omni-tree-v1", hash: "a".repeat(64), files: [] },
  },
} as const;

it("guards the origin read and binds its response to the exact requested source", async () => {
  ipcHandlers.clear();
  const assertTrustedSender = vi.fn((event: { sender?: string }) => {
    if (event.sender !== "trusted") throw new Error("Untrusted renderer sender.");
  });
  const readOrigin = vi.fn(async (): Promise<ReadSkillVariantOriginResponse> => ({ status: "ready", source, origin }));
  registerSkillManagementIpcHandlers(assertTrustedSender as never, {} as SkillManagementService, undefined, readOrigin);
  const handler = ipcHandlers.get(SKILL_MANAGEMENT_IPC_CHANNELS.variantOrigin);
  if (!handler) throw new Error("The variant origin IPC handler was not registered.");
  const request = { source };

  await expect(handler({ sender: "untrusted" }, request)).rejects.toThrow("Untrusted renderer sender.");
  expect(readOrigin).not.toHaveBeenCalled();
  await expect(handler({ sender: "trusted" }, request)).resolves.toEqual({ status: "ready", source, origin });
  expect(readOrigin).toHaveBeenCalledWith(source);

  readOrigin.mockResolvedValueOnce({ status: "ready", source: { ...source, artifactPath: "skills/other" }, origin });
  await expect(handler({ sender: "trusted" }, request)).rejects.toThrow("changed its requested source");
});
