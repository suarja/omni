import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { externalLibraryFixture } from "./external-library-fixture";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";
import { createExternalLibraryService } from "../../src/main/external-library/service";
import type { SkillIntent, SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";
import type { FileWriter } from "../../src/main/operation-files";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
export async function setUpdates(
  settings: ReturnType<typeof createSettingsStore>,
  updates: "auto" | "ask",
): Promise<void> {
  const current = await settings.read();
  await settings.set({
    commitChanges: current.git.commitChanges,
    agents: current.agents,
    ai: current.ai,
    features: current.features,
    externalLibrary: { updates },
  });
}

async function buildExternalOperationFixture(options: Readonly<{ fileWriter?: FileWriter }> = {}) {
  const f = await externalLibraryFixture();
  roots.push(f.root);
  const settings = createSettingsStore(settingsFilePath(f.data));
  await setUpdates(settings, "ask");
  const library = createExternalLibraryService({ userDataPath: f.data, homeDir: f.home, resolveUrl: f.resolveUrl });
  await library.check();
  const { registerRegistryIpcHandlers } = await import("../../src/main/registry-ipc");
  const registry = registerRegistryIpcHandlers(() => undefined, { userDataPath: f.data });
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const operations = registerOperationsIpcHandlers(() => undefined, registry, {
    userDataPath: f.data,
    homeDir: f.home,
    isPackaged: true,
    externalLibrary: library,
    ...(options.fileWriter ? { fileWriter: options.fileWriter } : {}),
  });
  const service = operations.skillManagement;
  const preview = async (intent: SkillIntent): Promise<Extract<SkillPreview, { status: "ready" }>> => {
    const result = await service.preview(intent, { kind: "desktop" });
    expect(result.status, JSON.stringify(result)).toBe("ready");
    if (result.status !== "ready") throw new Error("Preview unavailable.");
    return result;
  };
  const apply = (result: Extract<SkillPreview, { status: "ready" }>): Promise<SkillResult> =>
    service.apply(result.intentId, {
      kind: "desktop",
      effectFingerprint: result.effectFingerprint,
      approvedAt: new Date().toISOString(),
    });
  return { ...f, library, service, preview, apply, settings, operations, registry };
}

export function externalOperationFixture(
  options: Readonly<{ fileWriter?: FileWriter }> = {},
): ReturnType<typeof buildExternalOperationFixture> {
  return buildExternalOperationFixture(options);
}
