export type LoginItemState = Readonly<{ available: boolean; openAtLogin: boolean; status: string }>;
export const LOGIN_ITEM_CHANNELS = { get: "omni:login-item:get", set: "omni:login-item:set" } as const;
export function parseLoginItemSetRequest(value: unknown): Readonly<{ openAtLogin: boolean }> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Login item request must be an object.");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== "openAtLogin") || typeof request.openAtLogin !== "boolean")
    throw new Error("Login item request must contain only openAtLogin as a boolean.");
  return { openAtLogin: request.openAtLogin };
}
export function parseLoginItemState(value: unknown): LoginItemState {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Login item state must be an object.");
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).some((key) => !["available", "openAtLogin", "status"].includes(key)) ||
    typeof state.available !== "boolean" ||
    typeof state.openAtLogin !== "boolean" ||
    typeof state.status !== "string" ||
    !state.status ||
    state.status.length > 64
  )
    throw new Error("Login item state is invalid.");
  return { available: state.available, openAtLogin: state.openAtLogin, status: state.status };
}
export interface LoginItemDesktopApi {
  getLoginItem(): Promise<LoginItemState>;
  setLoginItem(request: Readonly<{ openAtLogin: boolean }>): Promise<LoginItemState>;
}
