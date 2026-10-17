import { isAbsolute, resolve } from "node:path";
import { parseAgentWriteRequest, type AgentWriteRequest } from "../../shared/agents-ipc";
import type { OperationStore } from "../operation-store";
import type { AgentClient } from "./server";
import { id, keys, object, optionalBoolean, text } from "./router-inputs";

type Preview = (
  request: AgentWriteRequest,
  client: AgentClient,
  askInOmni?: boolean,
) => Promise<Readonly<Record<string, unknown>>>;
export async function routeStorefrontLink(
  method: string,
  params: unknown,
  client: AgentClient,
  preview: Preview,
  store: OperationStore,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (method === "preview_restore") {
    const value = object(params, method);
    keys(value, ["operationId", "askInOmni"], method);
    const operationId = id(value.operationId, "Operation id");
    const history = await store.read();
    if (
      history.status !== "ready" ||
      !history.receipts.some((receipt) => receipt.operationId === operationId && receipt.kind === "link-storefront")
    )
      return undefined;
    return preview({ kind: "restore-skill", operationId }, client, optionalBoolean(value.askInOmni, "askInOmni"));
  }
  if (method !== "preview_link_storefront") return undefined;
  const value = object(params, method);
  keys(value, ["path", "reason"], method);
  const path = text(value.path, "Storefront path", 4096);
  const cwd = client.cwd && isAbsolute(client.cwd) ? client.cwd : undefined;
  if (!cwd && !isAbsolute(path))
    return {
      status: "blocked",
      reason: "storefront-cwd-unavailable",
      diagnostic: "Pass an absolute storefront path or provide the calling agent's working directory.",
    };
  const request = parseAgentWriteRequest({
    kind: "link-storefront",
    path: isAbsolute(path) ? path : resolve(cwd!, path),
    ...(value.reason === undefined ? {} : { reason: text(value.reason, "Link reason", 1024) }),
  });
  try {
    return await preview(request, client);
  } catch (error) {
    if (error instanceof Error && "registrationBlock" in error)
      return error.registrationBlock as Readonly<Record<string, unknown>>;
    throw error;
  }
}
