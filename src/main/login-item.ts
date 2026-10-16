import type { SettingsStore } from "./settings-store";
import type { LoginItemState } from "../shared/login-item-ipc";
import type { BuildChannel, ProfilePolicy } from "./runtime-identity";

type LoginItemOs = Readonly<{
  getLoginItemSettings(options: { type: "mainAppService" }): {
    openAtLogin: boolean;
    wasOpenedAtLogin: boolean;
    status: string;
  };
  setLoginItemSettings(settings: { openAtLogin: boolean; type: "mainAppService" }): void;
}>;
export interface LoginItemService {
  initialize(): Promise<void>;
  get(): Promise<LoginItemState>;
  set(openAtLogin: boolean): Promise<LoginItemState>;
  wasOpenedAtLogin(): boolean;
}
export function createLoginItemService(
  options: Readonly<{
    store: SettingsStore;
    os: LoginItemOs;
    platform: string;
    isPackaged: boolean;
    channel: BuildChannel;
    profileSource: ProfilePolicy["source"];
  }>,
): LoginItemService {
  const available =
    options.platform === "darwin" &&
    options.isPackaged &&
    options.channel === "release" &&
    options.profileSource === "default";
  const readOs = (): ReturnType<LoginItemOs["getLoginItemSettings"]> =>
    options.os.getLoginItemSettings({ type: "mainAppService" });
  const get = async (): Promise<LoginItemState> => {
    if (!available) return { available: false, openAtLogin: false, status: "unavailable" };
    const state = readOs();
    return { available, openAtLogin: state.openAtLogin && state.status === "enabled", status: state.status };
  };
  let queue = Promise.resolve();
  const initialize = (): Promise<void> => {
    const result = queue.then(async () => {
      if (!available || (await options.store.read()).login !== undefined) return;
      // Persist first: even an OS refusal must not cause automatic re-registration later.
      await options.store.recordLoginDecision(true);
      options.os.setLoginItemSettings({ openAtLogin: true, type: "mainAppService" });
    });
    queue = result.catch(() => undefined);
    return result;
  };
  const set = (openAtLogin: boolean): Promise<LoginItemState> => {
    const result = queue.then(async () => {
      if (!available)
        throw new Error("Open Omni at login is available only in the installed release with its default profile.");
      await options.store.recordLoginDecision(openAtLogin);
      options.os.setLoginItemSettings({ openAtLogin, type: "mainAppService" });
      return get();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return { initialize, get, set, wasOpenedAtLogin: () => available && readOs().wasOpenedAtLogin };
}
