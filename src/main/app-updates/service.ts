import type { AppUpdateState } from "../../shared/app-updates-ipc";
import type { UpdatePreferences } from "./preferences";

export type UpdatePolicy = Readonly<{
  isPackaged: boolean;
  channel: string;
  profileSource: string;
  signing: string;
  platform: string;
  test: boolean;
}>;
type Updater = Readonly<{
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  quitAndInstall(): void;
}>;
export interface AppUpdatesService {
  initialize(): Promise<void>;
  get(): Promise<AppUpdateState>;
  set(enabled: boolean): Promise<AppUpdateState>;
  restart(): Promise<void>;
  dispose(): void;
}
export function canUpdate(policy: UpdatePolicy): boolean {
  return (
    policy.isPackaged &&
    policy.channel === "release" &&
    policy.profileSource === "default" &&
    policy.signing === "developer-id" &&
    policy.platform === "darwin" &&
    !policy.test
  );
}
export function createAppUpdates(
  options: Readonly<{
    policy: UpdatePolicy;
    preferences: UpdatePreferences;
    updater: Updater;
    verifySignature: () => Promise<boolean>;
    start: () => { stopUpdates(): void };
    changed: (state: AppUpdateState) => void;
  }>,
): AppUpdatesService {
  let state: AppUpdateState = { available: false, enabled: true, downloaded: false, error: false };
  let initialization: Promise<void> | undefined;
  let session: { stopUpdates(): void } | undefined;
  let queue = Promise.resolve();
  let disposed = false;
  const publish = (): void => options.changed({ ...state });
  const onDownloaded = (): void => {
    if (!session || !state.enabled || disposed) return;
    state = { ...state, downloaded: true, error: false };
    publish();
  };
  const onError = (): void => {
    state = { ...state, error: true };
    publish();
  };
  function reconcile(): void {
    if (!state.available || !state.enabled || disposed) {
      session?.stopUpdates();
      session = undefined;
      state = { ...state, downloaded: false };
    } else if (!session) session = options.start();
  }
  async function initializeOnce(): Promise<void> {
    if (!canUpdate(options.policy)) return;
    const signed = await options.verifySignature();
    if (!signed || disposed) return;
    const enabled = await options.preferences.read();
    state = { ...state, available: true, enabled };
    options.updater.on("update-downloaded", onDownloaded);
    options.updater.on("error", onError);
    reconcile();
  }
  const initialize = (): Promise<void> =>
    (initialization ??= initializeOnce().catch(() => {
      state = { ...state, error: true };
      publish();
    }));
  const get = async (): Promise<AppUpdateState> => {
    await initialize();
    return { ...state };
  };
  function set(enabled: boolean): Promise<AppUpdateState> {
    const result = queue.then(async () => {
      await initialize();
      if (!state.available || disposed)
        throw new Error("App updates are available only in a signed release using its default profile.");
      await options.preferences.write(enabled);
      state = { ...state, enabled, error: false };
      reconcile();
      publish();
      return { ...state };
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function restart(): Promise<void> {
    await queue;
    await initialize();
    if (!state.available || !state.enabled || !state.downloaded || disposed)
      throw new Error("No enabled app update is downloaded. Keep using Omni and try again after download.");
    options.updater.quitAndInstall();
  }
  function dispose(): void {
    disposed = true;
    reconcile();
    options.updater.removeListener("update-downloaded", onDownloaded);
    options.updater.removeListener("error", onError);
  }
  return { initialize, get, set, restart, dispose };
}
