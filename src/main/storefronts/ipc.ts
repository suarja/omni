import { readPublicationContentChecks } from "./content-checks";
import {
  STOREFRONT_PRESENTATION_CHANNELS,
  parseStorefrontSourceRequest,
  parseStorefrontDetails,
  parseStorefrontCapabilities,
  parseStorefrontOpened,
  parsePublicationContentRequest,
  parsePublicationContentChecks,
} from "../../shared/storefront-presentation-ipc";
import { readStorefrontDetails, readInspectionPresentation } from "./presentation";
import { systemGhCli } from "../gh-cli";
import { randomUUID } from "node:crypto";
import { app, dialog, ipcMain, shell } from "electron";
import { parseEmptyRegistryRequest } from "../../shared/registry-ipc";
import {
  STOREFRONTS_IPC_CHANNELS,
  parseStorefrontDriftReport,
  parseStorefrontInspectResponse,
  parseStorefrontLinkRequest,
  parseStorefrontLinkResult,
} from "../../shared/storefronts-ipc";
import { createStorefrontService } from "./service";

type Options = Readonly<{
  userDataPath?: string;
  now?: () => number;
  directoryPicker?: Readonly<{
    showOpenDialog(options: {
      properties: readonly ["openDirectory"];
    }): Promise<{ canceled: boolean; filePaths: readonly string[] }>;
  }>;
}>;
export function registerStorefrontIpcHandlers(
  assertTrustedSender: (event: Electron.IpcMainInvokeEvent) => void,
  options: Options = {},
): void {
  const service = createStorefrontService({
    userDataPath: options.userDataPath ?? app.getPath("userData"),
    now: options.now,
  });
  const userDataPath = options.userDataPath ?? app.getPath("userData");
  ipcMain.handle(STOREFRONT_PRESENTATION_CHANNELS.contentChecks, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const { pluginId } = parsePublicationContentRequest(raw);
    return parsePublicationContentChecks(await readPublicationContentChecks(userDataPath, pluginId));
  });
  ipcMain.handle(STOREFRONT_PRESENTATION_CHANNELS.details, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const { sourceId } = parseStorefrontSourceRequest(raw);
    return parseStorefrontDetails(await readStorefrontDetails(userDataPath, sourceId));
  });
  ipcMain.handle(STOREFRONT_PRESENTATION_CHANNELS.capabilities, async (event, raw: unknown) => {
    assertTrustedSender(event);
    parseEmptyRegistryRequest(raw);
    if (!(await systemGhCli.available())) return { gh: "unavailable" };
    const login = await systemGhCli.login();
    return parseStorefrontCapabilities(login ? { gh: "ready", login } : { gh: "unauthenticated" });
  });
  ipcMain.handle(STOREFRONT_PRESENTATION_CHANNELS.openRepository, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const { sourceId } = parseStorefrontSourceRequest(raw);
    const details = await readStorefrontDetails(userDataPath, sourceId);
    if (details.status !== "ready") return details;
    const repository = details.inspection.githubRepository;
    if (!repository)
      return {
        status: "blocked",
        code: "github-unavailable",
        message: "The storefront has no recognized GitHub repository. Inspect its origin before opening it.",
      };
    try {
      await shell.openExternal(`https://github.com/${repository}`);
      return parseStorefrontOpened({ status: "opened" });
    } catch {
      return {
        status: "blocked",
        code: "browser-unavailable",
        message: "The repository could not be opened. Check the default browser and try again.",
      };
    }
  });
  const now = options.now ?? Date.now;
  const folders = new Map<string, Readonly<{ path: string; expiresAt: number }>>();
  ipcMain.handle(STOREFRONTS_IPC_CHANNELS.inspect, async (event, raw: unknown) => {
    assertTrustedSender(event);
    parseEmptyRegistryRequest(raw);
    const selected = await (options.directoryPicker ?? dialog).showOpenDialog({ properties: ["openDirectory"] });
    const path = selected.filePaths[0];
    if (selected.canceled || !path) return { status: "cancelled" };
    const inspection = await service.inspect(path);
    if (inspection.status !== "ready") return parseStorefrontInspectResponse(inspection);
    for (const [id, entry] of folders) if (entry.expiresAt <= now()) folders.delete(id);
    const inspectionId = randomUUID();
    folders.set(inspectionId, { path, expiresAt: now() + 300000 });
    try {
      return parseStorefrontInspectResponse({
        ...(await readInspectionPresentation(userDataPath, path, inspection)),
        inspectionId,
      });
    } catch {
      folders.delete(inspectionId);
      return {
        status: "blocked",
        code: "inspection-details-unavailable",
        message:
          "Storefront publication details could not be read safely. Restore access to the selected folder and inspect it again.",
      };
    }
  });
  ipcMain.handle(STOREFRONTS_IPC_CHANNELS.link, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const request = parseStorefrontLinkRequest(raw);
    const entry = folders.get(request.inspectionId);
    if (!entry || entry.expiresAt <= now())
      return {
        status: "blocked",
        code: "inspection-expired",
        message: "Inspect the storefront folder again before linking it.",
      };
    return parseStorefrontLinkResult(await service.link(entry.path));
  });
  ipcMain.handle(STOREFRONTS_IPC_CHANNELS.drift, async (event, raw: unknown) => {
    assertTrustedSender(event);
    parseEmptyRegistryRequest(raw);
    return parseStorefrontDriftReport(await service.readDrift());
  });
}
