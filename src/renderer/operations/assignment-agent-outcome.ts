import type { AgentsDesktopApi } from "../../shared/agents-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";

type CompletionApi = Partial<
  Pick<AgentsDesktopApi, "resolveAgentRequest" | "listAgentRequests" | "beginAgentApply" | "endAgentApply">
>;
export type AssignmentAuthorization = Readonly<{ approvedAt: string; leaseId?: string }>;

export async function authorizeAssignmentRequest(
  api: CompletionApi,
  requestId: string | undefined,
): Promise<AssignmentAuthorization | undefined> {
  if (!requestId) return undefined;
  if (!api.beginAgentApply || !api.endAgentApply || !api.resolveAgentRequest)
    throw new Error("Agent assignment authorization is unavailable; reopen the preview before applying.");
  return api.beginAgentApply({ requestId });
}

export async function releaseAssignmentRequest(
  api: CompletionApi,
  requestId: string | undefined,
  authorization: AssignmentAuthorization | undefined,
): Promise<void> {
  if (requestId && authorization?.leaseId) await api.endAgentApply?.({ requestId, leaseId: authorization.leaseId });
}

export async function completeAssignmentRequest(
  api: CompletionApi,
  requestId: string | undefined,
  receipts: readonly OperationReceipt[],
  authorization?: AssignmentAuthorization,
): Promise<void> {
  if (!requestId || !receipts.length) return;
  if (!api.resolveAgentRequest) throw new Error("Agent assignment completion is unavailable.");
  await api.resolveAgentRequest({
    requestId,
    operationIds: receipts.map((receipt) => receipt.operationId),
    outcome: { status: "applied" },
    ...authorization,
  });
}

export async function recordAssignmentFailure(
  api: CompletionApi,
  requestId: string | undefined,
  receipts: readonly OperationReceipt[],
  detail: string,
  authorization?: AssignmentAuthorization,
): Promise<void> {
  if (!requestId || !receipts.length) return;
  if (!api.resolveAgentRequest) throw new Error("Agent assignment completion is unavailable.");
  await api.resolveAgentRequest({
    requestId,
    operationIds: receipts.map((receipt) => receipt.operationId),
    outcome: {
      status: "failed",
      message:
        detail
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
          .trim()
          .slice(0, 2000) || "Assignment failed.",
    },
    ...authorization,
  });
}
