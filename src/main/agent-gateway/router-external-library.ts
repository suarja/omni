import type { AgentWriteRequest } from "../../shared/agents-ipc";
import { parseAgentWriteRequest } from "../../shared/agents-ipc";
import type { AgentClient } from "./server";
import type { ExternalLibraryService } from "../external-library/service";
import { empty, fail, keys, object, optionalBoolean } from "./router-inputs";

export async function routeExternalLibrary(
  method: string,
  params: unknown,
  client: AgentClient,
  library: ExternalLibraryService | undefined,
  preview: (
    request: AgentWriteRequest,
    client: AgentClient,
    askInOmni?: boolean,
  ) => Promise<Readonly<Record<string, unknown>>>,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (method === "list_external_library") {
    empty(params, method);
    if (!library) throw fail("The external library is unavailable. Reopen Omni.");
    const listed = await library.list();
    return { ...listed, sources: await Promise.all(listed.sources.map((source) => library.readSource(source.id))) };
  }
  if (method === "preview_install_external") {
    const value = object(params, method);
    keys(value, ["sourceId", "skillPath", "skillName", "targets", "conflict", "askInOmni"], method);
    const { askInOmni, ...request } = value;
    return preview(
      parseAgentWriteRequest({ ...request, kind: "install-external-skill" }),
      client,
      optionalBoolean(askInOmni, "askInOmni"),
    );
  }
  return undefined;
}
