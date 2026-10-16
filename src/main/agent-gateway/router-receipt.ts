import { parseAgentReceiptRequest, type AgentReceiptResponse } from "../../shared/agents-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import type { OperationStore } from "../operation-store";
import type { AgentRequestsStore } from "./requests-store";
import { fail } from "./router-inputs";

export function createAgentReceiptReader(
  requests: AgentRequestsStore,
  operationStore: OperationStore,
): (params: unknown) => Promise<AgentReceiptResponse> {
  return async (params) => {
    const request = parseAgentReceiptRequest(params);
    const stored = request.requestId ? await requests.get(request.requestId) : undefined;
    if (!stored?.intentId && stored?.applyOutcome && !(stored.receiptIds?.length ?? 0))
      return { status: "none", message: stored.applyOutcome.message ?? "This request produced no operation receipt." };
    const operationIds = request.operationId
      ? [request.operationId]
      : stored?.intentId
        ? [stored.intentId]
        : (stored?.receiptIds ?? (stored?.receiptId ? [stored.receiptId] : []));
    if (!operationIds.length) return { status: "missing" };
    const result = await operationStore.read();
    if (result.status !== "ready") throw fail("Receipts are unavailable.");
    const receipts = operationIds.flatMap((operationId) => {
      const found = result.receipts.find((item) => item.operationId === operationId);
      return found ? [found] : [];
    });
    const missingReceiptIds = operationIds.filter(
      (operationId) => !receipts.some((item) => item.operationId === operationId),
    );
    if (missingReceiptIds.length)
      return {
        status: "missing",
        message: "Some recorded receipts are unavailable; do not repeat this request's writes.",
        missingReceiptIds,
      };
    return { status: "found", receipt: receipts.at(-1)!, ...(request.requestId ? { receipts } : {}) };
  };
}
