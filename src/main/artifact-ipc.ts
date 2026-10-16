import { ipcMain } from "electron";

import type { RegistryGrantStore } from "./registry-ipc";
import { ARTIFACT_IPC_CHANNELS, parseReadArtifactRequest } from "../shared/artifact-ipc";
import { readGrantedArtifact } from "./artifact-reader";

export { MAX_ARTIFACT_BYTES } from "./artifact-reader";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;

export function registerArtifactIpcHandlers(assertTrustedSender: SenderGuard, grants: RegistryGrantStore): void {
  ipcMain.handle(ARTIFACT_IPC_CHANNELS.readArtifact, async (event, rawRequest: unknown) => {
    assertTrustedSender(event);
    try {
      const request = parseReadArtifactRequest(rawRequest);
      return await readGrantedArtifact(request, grants);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Artifact request failed safely.";
      throw new Error(message.length <= 240 && !/[\r\n]/.test(message) ? message : "Artifact request failed safely.");
    }
  });
}
