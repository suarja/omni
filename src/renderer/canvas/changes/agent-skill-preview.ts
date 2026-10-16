import type { DesktopApi } from "../../../shared/ipc";
import type { SkillPreview } from "../../../shared/skill-management-ipc";

type PreviewApi = Pick<DesktopApi, "refreshSkillOperation"> &
  Partial<Pick<DesktopApi, "listAgentRequests" | "refreshAgentRequest">>;
type RefreshedPreview = Readonly<{ preview: SkillPreview; updated: boolean }>;

function needsRecovery(preview: SkillPreview): boolean {
  return (
    preview.status === "stale" ||
    (preview.status === "blocked" && preview.details.some((item) => item.code === "intent-unavailable"))
  );
}

export function createAgentSkillPreviewReader(api: PreviewApi): Readonly<{
  read: (intentId: string, requestId?: string) => Promise<RefreshedPreview>;
  recover: (requestId: string) => Promise<SkillPreview>;
}> {
  const refreshPreview = async (intentId: string, requestId?: string): Promise<SkillPreview> => {
    if (!api.refreshSkillOperation) throw new Error("Skill changes are unavailable in this session.");
    return api.refreshSkillOperation({ intentId, ...(requestId ? { requestId } : {}) });
  };
  const linked = new Map<string, string>();
  const reads = new Map<string, Promise<RefreshedPreview>>();
  const recoveries = new Map<string, Promise<SkillPreview>>();
  const recover = (requestId: string): Promise<SkillPreview> => {
    const pending = recoveries.get(requestId);
    if (pending) return pending;
    const task = (async () => {
      if (!api.refreshAgentRequest) throw new Error("Agent request refresh is unavailable.");
      const request = await api.refreshAgentRequest(requestId);
      if (!request.intentId || !request.skillIntent) throw new Error("The refreshed request has no skill operation.");
      linked.set(requestId, request.intentId);
      return refreshPreview(request.intentId, requestId);
    })().finally(() => recoveries.delete(requestId));
    recoveries.set(requestId, task);
    return task;
  };
  const readCurrent = async (fallback: string, requestId?: string): Promise<RefreshedPreview> => {
    if (!requestId) return { preview: await refreshPreview(fallback), updated: false };
    const request = (await api.listAgentRequests?.())?.requests.find((item) => item.requestId === requestId);
    if (api.listAgentRequests && (!request || request.status !== "pending"))
      throw new Error("Only pending requests can be refreshed.");
    const intentId = request?.intentId ?? linked.get(requestId) ?? fallback;
    linked.set(requestId, intentId);
    let preview: SkillPreview;
    try {
      preview = await refreshPreview(intentId, requestId);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Agent request does not match this skill operation"))
        throw error;
      return { preview: await recover(requestId), updated: true };
    }
    return needsRecovery(preview)
      ? { preview: await recover(requestId), updated: true }
      : { preview, updated: intentId !== fallback };
  };
  return {
    recover,
    read: (intentId, requestId) => {
      if (!requestId) return readCurrent(intentId);
      const pending = reads.get(requestId);
      if (pending) return pending;
      const task = readCurrent(intentId, requestId).finally(() => reads.delete(requestId));
      reads.set(requestId, task);
      return task;
    },
  };
}
