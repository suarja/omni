import type { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { autoUpdater } from "electron";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import identity from "../../../resources/release-identity.json";
import { canUpdate, createAppUpdates, type AppUpdatesService, type UpdatePolicy } from "./service";
import { createUpdatePreferences } from "./preferences";
import type { AppUpdateState } from "../../shared/app-updates-ipc";

export function createElectronAppUpdates(
  options: Readonly<{
    appRoot: string;
    userDataPath: string;
    policy: UpdatePolicy;
    changed: (state: AppUpdateState) => void;
  }>,
): AppUpdatesService {
  return createAppUpdates({
    policy: options.policy,
    preferences: createUpdatePreferences(join(options.userDataPath, "omni", "app-updates.json")),
    updater: canUpdate(options.policy)
      ? autoUpdater
      : { on: () => undefined, removeListener: () => undefined, quitAndInstall: () => undefined },
    changed: options.changed,
    verifySignature: async () => {
      const requirement = `anchor apple generic and identifier "${identity.bundleId}" and certificate leaf[subject.OU] = "${identity.teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
      try {
        await promisify(execFile)("/usr/bin/codesign", [
          "--verify",
          "--strict",
          `-R=${requirement}`,
          resolve(options.appRoot, "../../.."),
        ]);
        return true;
      } catch {
        return false;
      }
    },
    start: () => {
      // update-electron-app stops its timer but retains listeners. Remove only those it added
      // so toggling the setting repeatedly does not accumulate logger/event subscriptions.
      const previous = new Map(autoUpdater.eventNames().map((name) => [name, autoUpdater.listeners(name)]));
      const session = updateElectronApp({
        updateSource: {
          type: UpdateSourceType.ElectronPublicUpdateService,
          repo: identity.repository,
          host: "https://update.electronjs.org",
        },
        notifyUser: false,
        updateInterval: "1 hour",
        logger: { log: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      const added = autoUpdater.eventNames().flatMap((name) =>
        autoUpdater
          .listeners(name)
          .filter((listener) => !previous.get(name)?.includes(listener))
          .map((listener) => ({ name, listener })),
      );
      return {
        stopUpdates: () => {
          session.stopUpdates();
          for (const { name, listener } of added)
            (autoUpdater as EventEmitter).removeListener(name, listener as (...args: unknown[]) => void);
        },
      };
    },
  });
}
