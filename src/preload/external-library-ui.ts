import {
  EXTERNAL_LIBRARY_UI_CHANNELS,
  parseExternalAddRequest,
  parseExternalDiscovery,
  parseExternalImportRequest,
  parseExternalImportSource,
  parseExternalRepositoryOpened,
  parseExternalSkillDocumentRequest,
  type ExternalLibraryUiDesktopApi,
} from "../shared/external-library-ui-ipc";
import { parseExternalSourceRequest } from "../shared/external-library-ipc";
import { parseReadArtifactResponse } from "../shared/artifact-ipc";
export function createExternalLibraryUiDesktopApi(
  invoke: (channel: string, request: unknown) => Promise<unknown>,
): ExternalLibraryUiDesktopApi {
  return {
    discoverExternalSource: async (request) =>
      parseExternalDiscovery(await invoke(EXTERNAL_LIBRARY_UI_CHANNELS.discover, parseExternalAddRequest(request))),
    prepareExternalSkillImport: async (request) =>
      parseExternalImportSource(
        await invoke(EXTERNAL_LIBRARY_UI_CHANNELS.importSource, parseExternalImportRequest(request)),
      ),
    readExternalSkillDocument: async (request) =>
      parseReadArtifactResponse(
        await invoke(EXTERNAL_LIBRARY_UI_CHANNELS.readDocument, parseExternalSkillDocumentRequest(request)),
      ),
    openExternalSourceRepository: async (request) =>
      parseExternalRepositoryOpened(
        await invoke(EXTERNAL_LIBRARY_UI_CHANNELS.openRepository, parseExternalSourceRequest(request)),
      ),
  };
}
