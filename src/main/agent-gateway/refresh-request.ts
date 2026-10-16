import type { SkillManagementService } from "../../application/skill-management";
import type { AgentPlan, AgentRequest, AgentWriteRequest } from "../../shared/agents-ipc";
import { parseAgentWriteRequest } from "../../shared/agents-ipc";
import type { SettingsStore } from "../settings-store";
import type { RegistryIpcServices } from "../registry-ipc";
import type { AgentRequestsStore } from "./requests-store";
import { deriveApprovalInput, resolveApproval } from "./approval";
import { planFor } from "./router-management";

type RefreshOptions = Readonly<{
  requests: AgentRequestsStore;
  registry: RegistryIpcServices;
  settings: SettingsStore;
  service: SkillManagementService;
  previewPlan: (request: AgentWriteRequest) => Promise<AgentPlan>;
}>;

export function createAgentRequestRefresher(options: RefreshOptions): (requestId: string) => Promise<AgentRequest> {
  const inFlight = new Map<string, Promise<AgentRequest>>();
  const refresh = async (requestId: string): Promise<AgentRequest> => {
    const request = await options.requests.get(requestId);
    if (!request) throw new Error("This request is no longer available; preview it again.");
    if (request.status !== "pending") throw new Error("Only pending requests can be refreshed.");
    const actor = {
      kind: "mcp" as const,
      requestId,
      ...(request.harness ? { harness: request.harness } : {}),
      ...(request.sessionName ? { sessionName: request.sessionName } : {}),
    };
    if (request.skillIntent && request.intentId) {
      const current = await options.service.refresh(request.intentId, actor);
      if (current.status === "ready") {
        const latest = await options.requests.get(requestId);
        if (!latest || latest.status !== "pending") throw new Error("Only pending requests can be refreshed.");
        return latest;
      }
      if (current.status !== "stale" && !current.details.some((item) => item.code === "intent-unavailable"))
        throw new Error(current.reason);
    }
    const preview = request.skillIntent ? await options.service.preview(request.skillIntent, actor) : undefined;
    if (preview && preview.status !== "ready") throw new Error(preview.reason);
    const ready = preview?.status === "ready" ? preview : undefined;
    const plan =
      ready && request.skillIntent
        ? planFor(ready, request.skillIntent)
        : await options.previewPlan(parseAgentWriteRequest(request.request));
    const decision = await resolveApproval({
      registry: options.registry,
      ...deriveApprovalInput(request.skillIntent ?? request.request, ready ?? plan),
      settings: await options.settings.read(),
      askInOmni: request.approvalReason?.code === "asked-in-omni",
    });
    // Desktop still owns consent for this pending request, even if its refreshed reason is absent.
    return options.requests.refresh(requestId, {
      plan,
      ...(decision.reason ? { approvalReason: decision.reason } : {}),
      ...(ready ? { intentId: ready.intentId, skillIntent: request.skillIntent } : {}),
    });
  };
  return (requestId) => {
    const pending = inFlight.get(requestId);
    if (pending) return pending;
    const task = refresh(requestId).finally(() => inFlight.delete(requestId));
    inFlight.set(requestId, task);
    return task;
  };
}
