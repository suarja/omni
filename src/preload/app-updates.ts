import { ipcRenderer } from "electron";
import {
  APP_UPDATE_CHANNELS,
  parseAppUpdateState,
  parseUpdateEnabled,
  type AppUpdatesDesktopApi,
} from "../shared/app-updates-ipc";

export function createAppUpdatesDesktopApi(): AppUpdatesDesktopApi {
  return {
    getAppUpdates: async () => parseAppUpdateState(await ipcRenderer.invoke(APP_UPDATE_CHANNELS.get, {})),
    setAppUpdates: async (request) => {
      parseUpdateEnabled(request);
      return parseAppUpdateState(await ipcRenderer.invoke(APP_UPDATE_CHANNELS.set, request));
    },
    restartForUpdate: async () => {
      await ipcRenderer.invoke(APP_UPDATE_CHANNELS.restart, {});
    },
    onAppUpdatesChanged: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        let state;
        try {
          state = parseAppUpdateState(raw);
        } catch {
          return;
        }
        listener(state);
      };
      ipcRenderer.on(APP_UPDATE_CHANNELS.changed, receive);
      return () => {
        ipcRenderer.removeListener(APP_UPDATE_CHANNELS.changed, receive);
      };
    },
  };
}
