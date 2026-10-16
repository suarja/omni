import { assertKeys, assertRecord, readText } from "./operations-ipc-parser-utils";

export type RegisterMcpHarness = "claude-code" | "codex";
export type RegisterMcpAction = "enable" | "disable";
export type RegisterMcpRequest = Readonly<{
  kind: "register-mcp";
  harness: RegisterMcpHarness;
  action: RegisterMcpAction;
}>;

export function parseRegisterMcpRequest(value: unknown): RegisterMcpRequest {
  const request = assertRecord(value, "MCP registration request");
  assertKeys(request, ["kind", "harness", "action"], "MCP registration request");
  if (request.kind !== "register-mcp") throw new Error("Operation kind is invalid.");
  const harness = readText(request.harness, "MCP harness");
  if (harness !== "claude-code" && harness !== "codex") throw new Error("MCP harness is invalid.");
  const action = readText(request.action, "MCP action");
  if (action !== "enable" && action !== "disable") throw new Error("MCP action is invalid.");
  return { kind: "register-mcp", harness, action };
}
