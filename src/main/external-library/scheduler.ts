import type { ExternalPass } from "../../shared/external-library-ipc";
export interface ExternalLibraryScheduler {
  start(): Promise<ExternalPass>;
  checkNow(): Promise<ExternalPass>;
  stop(): void;
}
export function createExternalLibraryScheduler(
  service: Readonly<{ check(): Promise<ExternalPass> }>,
): ExternalLibraryScheduler {
  let launch: Promise<ExternalPass> | undefined, active: Promise<ExternalPass> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const checkNow = (): Promise<ExternalPass> => {
    if (!active)
      active = service.check().finally(() => {
        active = undefined;
      });
    return active;
  };
  return {
    start: () => {
      if (!launch) {
        launch = checkNow();
        timer = setInterval(
          () => {
            void checkNow().catch(() => undefined);
          },
          24 * 60 * 60 * 1000,
        );
        timer.unref?.();
      }
      return launch;
    },
    checkNow,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
