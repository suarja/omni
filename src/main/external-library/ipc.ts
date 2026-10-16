import { ipcMain } from "electron";
import { parseEmptyRegistryRequest } from "../../shared/registry-ipc";
import {
  EXTERNAL_LIBRARY_CHANNELS,
  parseExternalSourceRequest,
  parseExternalComparisonRequest,
  parseExternalAddRequest,
  parseExternalLibraryList,
  parseExternalSourceDetails,
  parseExternalComparison,
  parseExternalMacSources,
  parseExternalSourceAddResult,
  parseExternalPass,
} from "../../shared/external-library-ipc";
import type { ExternalLibraryService } from "./service";
export function registerExternalLibraryIpc(
  assertSender: (event: Electron.IpcMainInvokeEvent) => void,
  service: ExternalLibraryService,
): void {
  ipcMain.handle(EXTERNAL_LIBRARY_CHANNELS.acknowledge, async (event, raw: unknown) => {
    assertSender(event);
    const { useId } = parseExternalComparisonRequest(raw);
    return parseExternalSourceDetails(await service.acknowledgeRemoved(useId));
  });
  ipcMain.handle(EXTERNAL_LIBRARY_CHANNELS.list, async (event, raw: unknown) => {
    assertSender(event);
    parseEmptyRegistryRequest(raw);
    return parseExternalLibraryList(await service.list());
  });
  ipcMain.handle(EXTERNAL_LIBRARY_CHANNELS.source, async (event, raw: unknown) => {
    assertSender(event);
    const { sourceId } = parseExternalSourceRequest(raw);
    return parseExternalSourceDetails(await service.readSource(sourceId));
  });
  ipcMain.handle(EXTERNAL_LIBRARY_CHANNELS.compare, async (event, raw: unknown) => {
    assertSender(event);
    const { useId } = parseExternalComparisonRequest(raw);
    return parseExternalComparison(await service.compare(useId));
  });
  ipcMain.handle(EXTERNAL_LIBRARY_CHANNELS.onMac, async (event, raw: unknown) => {
    assertSender(event);
    parseEmptyRegistryRequest(raw);
    return parseExternalMacSources(await service.onMac());
  });
  ipcMain.handle(EXTERNAL_LIBRARY_CHANNELS.add, async (event, raw: unknown) => {
    assertSender(event);
    const { repository } = parseExternalAddRequest(raw);
    return parseExternalSourceAddResult(await service.add(repository));
  });
  ipcMain.handle(EXTERNAL_LIBRARY_CHANNELS.check, async (event, raw: unknown) => {
    assertSender(event);
    parseEmptyRegistryRequest(raw);
    return parseExternalPass(await service.check());
  });
}
