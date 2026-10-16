import { activeWorkshop } from "../domain/source-roles";
// Registers the guard's per-project "warn only" switch (Brief B1, item 6) and keeps guard.json
// in sync with it. `createLocalJsonRegistryStore`/`createSettingsStore` are both memoized by
// resolved file path, so calling them again here (without threading extra dependencies through
// src/main/index.ts) reuses the exact same in-memory store the rest of the app already writes
// through — never a second, stale copy.
import { ipcMain } from "electron";
import { join } from "node:path";

import { createLocalJsonRegistryStore } from "../adapters/registry/local-json";
import type { ProjectSourceRegistryStore } from "../ports/project-source-registry";
import {
  GUARD_IPC_CHANNELS,
  parseSetGuardProjectModeRequest,
  type SetGuardProjectModeResponse,
} from "../shared/guard-ipc";
import { createSettingsStore, settingsFilePath, type SettingsStore } from "./settings-store";
import { writeGuardConfig } from "./omni-guard-runtime";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type GuardIpcOptions = Readonly<{
  userDataPath: string;
  settingsStore?: SettingsStore;
  registryStore?: ProjectSourceRegistryStore;
}>;

function registryStoreFor(options: GuardIpcOptions): ProjectSourceRegistryStore {
  return (
    options.registryStore ??
    createLocalJsonRegistryStore(join(options.userDataPath, "omni", "project-source-registry.json"))
  );
}

/**
 * Rewrites guard.json from the current registry (active personal sources → marketplaceRoots)
 * and settings (`agents.guard.warnProjectIds` → warnProjects, resolved to each project's
 * canonical path). Called at startup and after every warn-switch change (item 5); guard.json is
 * Omni's own data, never part of a receipt.
 */
export async function refreshGuardConfig(options: GuardIpcOptions): Promise<void> {
  const settingsStore = options.settingsStore ?? createSettingsStore(settingsFilePath(options.userDataPath));
  const registryStore = registryStoreFor(options);
  const [settings, registry] = await Promise.all([settingsStore.read(), registryStore.read()]);
  const projects = registry.status === "ready" ? registry.state.projects : [];
  const sources = registry.status === "ready" ? registry.state.sources : [];
  const workshop = activeWorkshop({ sources });
  const marketplaceRoots = workshop ? [workshop.locator.canonicalPath] : [];
  const warnIds = new Set(settings.agents.guard.warnProjectIds);
  const warnProjects = projects
    .filter((project) => warnIds.has(project.id) && !project.archivedAt)
    .map((project) => project.locator.canonicalPath);
  await writeGuardConfig({ userDataPath: options.userDataPath, marketplaceRoots, warnProjects });
}

export function registerGuardIpcHandlers(assertTrustedSender: SenderGuard, options: GuardIpcOptions): void {
  const settingsStore = options.settingsStore ?? createSettingsStore(settingsFilePath(options.userDataPath));
  const registryStore = registryStoreFor(options);
  ipcMain.handle(
    GUARD_IPC_CHANNELS.setProjectMode,
    async (event, raw: unknown): Promise<SetGuardProjectModeResponse> => {
      assertTrustedSender(event);
      const request = parseSetGuardProjectModeRequest(raw);
      const current = await settingsStore.read();
      const warnSet = new Set(current.agents.guard.warnProjectIds);
      if (request.warn) warnSet.add(request.projectId);
      else warnSet.delete(request.projectId);
      const next = await settingsStore.set({
        commitChanges: current.git.commitChanges,
        agents: { approval: current.agents.approval, guard: { warnProjectIds: [...warnSet] } },
        ai: current.ai,
        features: current.features,
        externalLibrary: current.externalLibrary,
      });
      await refreshGuardConfig({ userDataPath: options.userDataPath, settingsStore, registryStore });
      return next.agents.guard;
    },
  );
}
