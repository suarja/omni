import { ipcMain } from "electron";
import { LOGIN_ITEM_CHANNELS, parseLoginItemSetRequest } from "../shared/login-item-ipc";
import { parseEmptySettingsRequest } from "../shared/settings-ipc";
import type { LoginItemService } from "./login-item";
export function registerLoginItemIpcHandlers(
  assertTrustedSender: (event: Electron.IpcMainInvokeEvent) => void,
  service: LoginItemService,
): void {
  ipcMain.handle(LOGIN_ITEM_CHANNELS.get, async (event, request: unknown) => {
    assertTrustedSender(event);
    parseEmptySettingsRequest(request);
    return service.get();
  });
  ipcMain.handle(LOGIN_ITEM_CHANNELS.set, async (event, request: unknown) => {
    assertTrustedSender(event);
    return service.set(parseLoginItemSetRequest(request).openAtLogin);
  });
}
