import { ipcMain } from "electron";

import {
  ACADEMY_IPC_CHANNELS,
  parseAcademyFirstLaunchRequest,
  parseAcademyLessonRequest,
  parseAcademyListRequest,
  parseAcademyLessonResponse,
  parseAcademyListResponse,
  parseAcademyScreenshotRequest,
  parseAcademyScreenshotResponse,
  type AcademyLessonResponse,
  type AcademyListResponse,
} from "../../shared/academy-ipc";
import { academySummary, loadAcademyScreenshot, loadAcademySnapshot, readFirstLaunch } from "./index";
import type { ResourceOptions } from "../omni-resources";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;

export type AcademyIpcOptions = Readonly<{
  userDataPath: string;
  resourceOptions?: ResourceOptions;
  now?: () => string;
}>;

export function registerAcademyIpcHandlers(assertTrustedSender: SenderGuard, options: AcademyIpcOptions): void {
  let snapshotPromise: ReturnType<typeof loadAcademySnapshot> | undefined;
  const snapshot = (): ReturnType<typeof loadAcademySnapshot> => {
    snapshotPromise ??= loadAcademySnapshot(options.resourceOptions);
    return snapshotPromise;
  };

  ipcMain.handle(ACADEMY_IPC_CHANNELS.list, async (event, raw: unknown): Promise<AcademyListResponse> => {
    assertTrustedSender(event);
    const request = parseAcademyListRequest(raw);
    return parseAcademyListResponse({ lessons: academySummary(await snapshot(), request.lang) });
  });

  ipcMain.handle(ACADEMY_IPC_CHANNELS.lesson, async (event, raw: unknown): Promise<AcademyLessonResponse> => {
    assertTrustedSender(event);
    const request = parseAcademyLessonRequest(raw);
    const lesson = (await snapshot()).lessons.find(
      (candidate) =>
        candidate.lang === request.lang && candidate.kind === request.kind && candidate.slug === request.slug,
    );
    return parseAcademyLessonResponse(lesson ? { status: "ready", lesson } : { status: "not-found" });
  });

  ipcMain.handle(ACADEMY_IPC_CHANNELS.screenshot, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const request = parseAcademyScreenshotRequest(raw);
    return parseAcademyScreenshotResponse(await loadAcademyScreenshot(request.name, options.resourceOptions));
  });

  ipcMain.handle(ACADEMY_IPC_CHANNELS.firstLaunch, async (event, raw: unknown) => {
    assertTrustedSender(event);
    parseAcademyFirstLaunchRequest(raw);
    return readFirstLaunch(options.userDataPath, options.now);
  });
}
