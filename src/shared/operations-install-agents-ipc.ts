import { assertKeys, assertRecord } from "./operations-ipc-parser-utils";
import type { AgentHarness } from "./agents-ipc";

export type InstallAgentsRequest = Readonly<{
  kind: "install-agents";
  harnesses: readonly AgentHarness[];
  force?: boolean;
}>;

export function parseInstallAgentsRequest(value: unknown): InstallAgentsRequest {
  const request = assertRecord(value, "Agent installation request");
  assertKeys(request, ["kind", "harnesses", "force"], "Agent installation request");
  if (request.kind !== "install-agents") throw new Error("Operation kind is invalid.");
  if (!Array.isArray(request.harnesses) || request.harnesses.length === 0)
    throw new Error("At least one agent harness is required.");
  if (request.harnesses.some((item) => item !== "claude-code" && item !== "codex"))
    throw new Error("Agent harness is invalid.");
  if (new Set(request.harnesses).size !== request.harnesses.length) throw new Error("Agent harnesses must be unique.");
  if (request.force !== undefined && typeof request.force !== "boolean")
    throw new Error("Agent force must be a boolean.");
  return {
    kind: "install-agents",
    harnesses: request.harnesses,
    ...(request.force === undefined ? {} : { force: request.force }),
  };
}
