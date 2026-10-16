export type AppUpdateState = Readonly<{
  available: boolean;
  enabled: boolean;
  downloaded: boolean;
  error: boolean;
}>;
export const APP_UPDATE_CHANNELS = {
  get: "omni:app-update:get",
  set: "omni:app-update:set",
  restart: "omni:app-update:restart",
  changed: "omni:app-update:changed",
} as const;

export function parseAppUpdateState(value: unknown): AppUpdateState {
  const state = parseRecord(value);
  const fields = ["available", "enabled", "downloaded", "error"] as const;
  if (Object.keys(state).length !== fields.length || !fields.every((key) => typeof state[key] === "boolean"))
    throw new Error("App update state is invalid.");
  return state as AppUpdateState;
}
export function parseUpdateEnabled(value: unknown): boolean {
  const request = parseRecord(value);
  if (Object.keys(request).length !== 1 || typeof request.enabled !== "boolean")
    throw new Error("App update request must contain only enabled as a boolean.");
  return request.enabled;
}
function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("App update request must be an object.");
  return value as Record<string, unknown>;
}
export interface AppUpdatesDesktopApi {
  getAppUpdates(): Promise<AppUpdateState>;
  setAppUpdates(request: Readonly<{ enabled: boolean }>): Promise<AppUpdateState>;
  restartForUpdate(): Promise<void>;
  onAppUpdatesChanged(listener: (state: AppUpdateState) => void): () => void;
}
