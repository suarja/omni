// IPC contract for the guard's per-project "warn only" switch (Brief B1, item 6). One writer
// (src/main/guard-ipc.ts) owns both sides of the effect: it updates `agents.guard` in settings
// and rewrites guard.json so the running guard script picks up the change immediately.
import type { GuardSettings } from "./settings-ipc";

export const GUARD_IPC_CHANNELS = { setProjectMode: "omni:guard:set-project-mode" } as const;

export type SetGuardProjectModeRequest = Readonly<{ projectId: string; warn: boolean }>;
export type SetGuardProjectModeResponse = GuardSettings;

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error(`${label} is invalid.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export function parseSetGuardProjectModeRequest(value: unknown): SetGuardProjectModeRequest {
  const request = record(value, "Guard project mode request");
  keys(request, ["projectId", "warn"], "Guard project mode request");
  if (typeof request.warn !== "boolean") throw new Error("Guard project mode warn flag is invalid.");
  return { projectId: id(request.projectId, "Project id"), warn: request.warn };
}

export function parseSetGuardProjectModeResponse(value: unknown): SetGuardProjectModeResponse {
  const response = record(value, "Guard project mode response");
  keys(response, ["warnProjectIds"], "Guard project mode response");
  if (
    !Array.isArray(response.warnProjectIds) ||
    response.warnProjectIds.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error("Guard project mode response is invalid.");
  return { warnProjectIds: response.warnProjectIds };
}

export interface GuardDesktopApi {
  setGuardProjectMode(request: SetGuardProjectModeRequest): Promise<SetGuardProjectModeResponse>;
}
