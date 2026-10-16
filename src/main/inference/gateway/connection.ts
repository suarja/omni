import type { Connection, PresetId } from "../../../shared/ai-gateway-ipc";

import { presetFor } from "./presets";

export type KeyState = "set" | "none";
export type ConnectionState = Readonly<{ connection?: Connection; keyState: KeyState; scope?: "remote" | "local" }>;

export function connectionId(connection: Connection): string {
  return connection.preset;
}

export function createConnection(preset: PresetId, baseUrl?: string): Connection {
  const definition = presetFor(preset);
  const resolvedBaseUrl = baseUrl ?? definition.openAiCompatible?.defaultBaseUrl;
  return {
    preset,
    ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
    displayName: definition.displayName,
  };
}

export function keyStateFor(connection: Connection, hasKey: boolean): ConnectionState {
  return { connection, keyState: hasKey ? "set" : "none", scope: presetFor(connection.preset).scope };
}
