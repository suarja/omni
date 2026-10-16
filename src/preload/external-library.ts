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
  type ExternalLibraryDesktopApi,
} from "../shared/external-library-ipc";

export function createExternalLibraryDesktopApi(
  invoke: (channel: string, request: unknown) => Promise<unknown>,
): ExternalLibraryDesktopApi {
  return {
    acknowledgeRemovedExternalUse: async (request) =>
      parseExternalSourceDetails(
        await invoke(EXTERNAL_LIBRARY_CHANNELS.acknowledge, parseExternalComparisonRequest(request)),
      ),
    listExternalSources: async () => parseExternalLibraryList(await invoke(EXTERNAL_LIBRARY_CHANNELS.list, {})),
    readExternalSource: async (request) =>
      parseExternalSourceDetails(await invoke(EXTERNAL_LIBRARY_CHANNELS.source, parseExternalSourceRequest(request))),
    compareExternalUse: async (request) =>
      parseExternalComparison(await invoke(EXTERNAL_LIBRARY_CHANNELS.compare, parseExternalComparisonRequest(request))),
    listExternalSourcesOnMac: async () => parseExternalMacSources(await invoke(EXTERNAL_LIBRARY_CHANNELS.onMac, {})),
    addExternalSource: async (request) =>
      parseExternalSourceAddResult(await invoke(EXTERNAL_LIBRARY_CHANNELS.add, parseExternalAddRequest(request))),
    checkExternalLibrary: async () => parseExternalPass(await invoke(EXTERNAL_LIBRARY_CHANNELS.check, {})),
  };
}
