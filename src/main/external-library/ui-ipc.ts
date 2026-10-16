import { ipcMain } from "electron";
import {
  EXTERNAL_LIBRARY_UI_CHANNELS,
  parseExternalAddRequest,
  parseExternalDiscovery,
  parseExternalImportRequest,
  parseExternalImportSource,
  parseExternalRepositoryOpened,
  parseExternalSkillDocumentRequest,
} from "../../shared/external-library-ui-ipc";
import { parseExternalSourceRequest } from "../../shared/external-library-ipc";
import { parseReadArtifactResponse } from "../../shared/artifact-ipc";
import type { createExternalLibraryUiAdapter } from "./ui-adapter";
export function registerExternalLibraryUiIpc(
  assertSender: (event: Electron.IpcMainInvokeEvent) => void,
  adapter: ReturnType<typeof createExternalLibraryUiAdapter>,
): void {
  ipcMain.handle(EXTERNAL_LIBRARY_UI_CHANNELS.discover, async (event, raw: unknown) => {
    assertSender(event);
    const request = parseExternalAddRequest(raw);
    return parseExternalDiscovery(await adapter.discover(request.repository));
  });
  ipcMain.handle(EXTERNAL_LIBRARY_UI_CHANNELS.importSource, async (event, raw: unknown) => {
    assertSender(event);
    return parseExternalImportSource(await adapter.importSource(parseExternalImportRequest(raw)));
  });
  ipcMain.handle(EXTERNAL_LIBRARY_UI_CHANNELS.readDocument, async (event, raw: unknown) => {
    assertSender(event);
    return parseReadArtifactResponse(await adapter.readDocument(parseExternalSkillDocumentRequest(raw)));
  });
  ipcMain.handle(EXTERNAL_LIBRARY_UI_CHANNELS.openRepository, async (event, raw: unknown) => {
    assertSender(event);
    const request = parseExternalSourceRequest(raw);
    return parseExternalRepositoryOpened(await adapter.openRepository(request.sourceId));
  });
}
