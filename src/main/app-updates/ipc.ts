import { ipcMain } from "electron";
import { APP_UPDATE_CHANNELS, parseUpdateEnabled } from "../../shared/app-updates-ipc";
import { parseEmptySettingsRequest } from "../../shared/settings-ipc";
import type { AppUpdatesService } from "./service";

export function registerAppUpdatesIpc(
  assertTrustedSender: (event: Electron.IpcMainInvokeEvent) => void,
  service: AppUpdatesService,
): void {
  ipcMain.handle(APP_UPDATE_CHANNELS.get, async (event, raw: unknown) => {
    assertTrustedSender(event);
    parseEmptySettingsRequest(raw);
    return service.get();
  });
  ipcMain.handle(APP_UPDATE_CHANNELS.set, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return service.set(parseUpdateEnabled(raw));
  });
  ipcMain.handle(APP_UPDATE_CHANNELS.restart, async (event, raw: unknown) => {
    assertTrustedSender(event);
    parseEmptySettingsRequest(raw);
    await service.restart();
  });
}
