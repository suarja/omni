import { app, ipcMain } from "electron";

import { createSettingsStore, settingsFilePath, type SettingsStore } from "./settings-store";
import { SETTINGS_IPC_CHANNELS, parseEmptySettingsRequest, parseSettingsSetRequest } from "../shared/settings-ipc";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;
type SettingsIpcOptions = Readonly<{ userDataPath?: string; settingsStore?: SettingsStore }>;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Settings request failed safely.";
  return message.length <= 240 && !/[\r\n]/.test(message) && !/(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(message)
    ? message
    : "Settings request failed safely.";
}

export function registerSettingsIpcHandlers(assertTrustedSender: SenderGuard, options: SettingsIpcOptions = {}): void {
  const store =
    options.settingsStore ?? createSettingsStore(settingsFilePath(options.userDataPath ?? app.getPath("userData")));
  const guard =
    <T>(handler: (request: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, request: unknown): Promise<T> => {
      assertTrustedSender(event);
      try {
        return await handler(request);
      } catch (error: unknown) {
        throw new Error(safeError(error));
      }
    };
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.get,
    guard(async (request) => {
      parseEmptySettingsRequest(request);
      return store.read();
    }),
  );
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.set,
    guard((request) => store.set(parseSettingsSetRequest(request))),
  );
}
