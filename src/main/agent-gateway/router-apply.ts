import type { AgentClient } from "./server";
import { parseAgentWriteRequest } from "../../shared/agents-ipc";
import type {
  AgentApplyOutcome,
  AgentReceiptResponse,
  AgentRequest,
  AgentWriteRequest,
  AgentPlan,
} from "../../shared/agents-ipc";
import type { ApplyOperationResponse, OperationPlan, OperationReceipt } from "../../shared/operations-ipc";
import type { OperationsIpcServices } from "../operations-ipc";
import type { AgentRequestsStore } from "./requests-store";
import type { OperationStore } from "../operation-store";
import type { SkillManagementService } from "../../application/skill-management";
import { samePlan } from "../../shared/agent-plan-freshness";
import { fail, id, keys, object } from "./router-inputs";
import { applyManagedSkill, verifiedSkillResult } from "./router-management";

type PreviewPlan = (request: AgentWriteRequest) => Promise<AgentPlan>;
type ApplyResult =
  | Readonly<{ status: "applied"; receipt: OperationReceipt; receipts: readonly OperationReceipt[] }>
  | Readonly<{ status: "failed"; message: string; receipt?: OperationReceipt; receipts?: readonly OperationReceipt[] }>
  | Readonly<{ status: "stale"; message: string }>;
type ApplyOptions = Readonly<{
  operations: OperationsIpcServices;
  requests: AgentRequestsStore;
  operationStore: OperationStore;
  skillManagement?: SkillManagementService;
  previewPlan: PreviewPlan;
  receipt: (request: AgentRequest) => Promise<AgentReceiptResponse>;
  now: () => number;
}>;

function agentIdentity(request: AgentRequest): Readonly<{
  harness?: "claude-code" | "codex";
  sessionName?: string;
}> {
  const harness =
    request.harness ?? (request.request.kind === "write-skill" ? request.request.agent?.harness : undefined);
  const sessionName =
    request.sessionName ?? (request.request.kind === "write-skill" ? request.request.agent?.sessionName : undefined);
  return { ...(harness ? { harness } : {}), ...(sessionName ? { sessionName } : {}) };
}

function agentProvenance(request: AgentRequest): NonNullable<OperationReceipt["provenance"]> {
  const identity = agentIdentity(request);
  return {
    approval: request.approval,
    ...(identity.harness
      ? {
          agent: {
            harness: identity.harness,
            ...(identity.sessionName ? { sessionName: identity.sessionName } : {}),
            requestedAt:
              request.request.kind === "write-skill"
                ? (request.request.agent?.requestedAt ?? request.createdAt)
                : request.createdAt,
          },
        }
      : {}),
  };
}

async function applyOperation(
  request: AgentRequest,
  plan: OperationPlan,
  options: ApplyOptions,
): Promise<ApplyOperationResponse | undefined> {
  return options.operations.applyOperation({ planId: plan.planId, provenance: agentProvenance(request) });
}

async function applySingleOperation(
  request: AgentRequest,
  plan: OperationPlan,
  options: ApplyOptions,
): Promise<ApplyResult | undefined> {
  const result = await applyOperation(request, plan, options);
  if (!result) return undefined;
  if (result.status === "applied") return { status: "applied", receipt: result.receipt, receipts: [result.receipt] };
  return {
    status: "failed",
    message: result.receipt.diagnostic ?? "The operation failed after producing a receipt.",
    receipt: result.receipt,
    ...(result.receipt.kind === "register-project" && result.receipt.project
      ? { projectId: result.receipt.project.id }
      : {}),
    receipts: [result.receipt],
  };
}

function errorMessage(error: unknown): string {
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : "The assignment failed safely.";
  return (
    message
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .trim()
      .slice(0, 2000) || "The assignment failed safely."
  );
}

function replayOutcome(request: AgentRequest, result: AgentReceiptResponse): unknown {
  if (result.status === "none") return { status: request.applyOutcome?.status ?? "no-op", message: result.message };
  if (result.status === "missing")
    return {
      status: "failed",
      message: result.message ?? "Recorded receipts are unavailable; do not repeat this request's writes.",
      ...(result.missingReceiptIds ? { missingReceiptIds: result.missingReceiptIds } : {}),
    };
  const receipts = result.receipts ?? [result.receipt];
  const outcome = request.applyOutcome?.status ?? (result.receipt.status === "applied" ? "applied" : "failed");
  return {
    status: outcome,
    receipt: result.receipt,
    ...(result.receipt.kind === "register-project" && result.receipt.project
      ? { projectId: result.receipt.project.id }
      : {}),
    ...(request.applyOutcome?.message ? { message: request.applyOutcome.message } : {}),
    ...(receipts.length > 1 || request.receiptIds ? { receipts } : {}),
  };
}

async function executeApply(params: unknown, options: ApplyOptions): Promise<unknown> {
  const value = object(params, "apply parameters");
  keys(value, ["requestId", "waitMs"], "apply parameters");
  const requestId = id(value.requestId, "Request id");
  const existing = await options.requests.get(requestId);
  if (!existing) throw fail("This request is no longer available; preview it again.");
  const resolved =
    existing.status === "pending" ? await options.requests.wait(requestId, applyWaitMs(value.waitMs)) : existing;
  if (!resolved) throw fail("This request is no longer available; preview it again.");
  if (resolved.status === "expired") return { status: "expired" as const };
  if (resolved.status === "pending")
    return {
      status: "pending",
      requestId,
      ...(resolved.approvalReason ? { approvalReason: resolved.approvalReason } : {}),
      message:
        "Approval is pending in Omni Desktop. Call omni_apply again with the same requestId; the request does not expire.",
    };
  if (resolved.status === "declined") return { status: "declined" as const };
  if (resolved.request.kind === "assign" && !resolved.intentId)
    return {
      status: "stale" as const,
      message: "This saved assignment predates managed skill operations. Preview it again before applying.",
    };
  if (resolved.intentId && options.skillManagement) {
    const result = await options.skillManagement.readResult(resolved.intentId);
    if (result && (resolved.applyOutcome || resolved.receiptId))
      return verifiedSkillResult(result, options.operationStore);
  }
  if (resolved.applyOutcome || resolved.receiptId) return replayOutcome(resolved, await options.receipt(resolved));
  if (resolved.approval === "omni")
    return { status: "failed" as const, message: "The approved receipt is unavailable." };
  if (resolved.plan.kind !== "assign" && resolved.plan.findings?.some((finding) => finding.severity === "error"))
    return { status: "failed" as const, message: "The plan is blocked and cannot be applied." };

  if (resolved.intentId) {
    if (!options.skillManagement)
      return { status: "failed" as const, message: "The managed skill operation is unavailable." };
    return applyManagedSkill({
      request: resolved,
      service: options.skillManagement,
      requests: options.requests,
      operationStore: options.operationStore,
    });
  }
  if (resolved.plan.kind === "assign")
    return { status: "failed" as const, message: "The saved assignment is not linked to a managed skill operation." };

  const lease = await options.requests.acquireApplyAuthorization(requestId);
  try {
    const identity = agentIdentity(resolved);
    const consent = {
      mode: resolved.approval,
      at: lease.approvedAt,
      ...(identity.harness ? { harness: identity.harness } : {}),
      ...(identity.sessionName ? { sessionName: identity.sessionName } : {}),
    };

    let freshPlan: AgentPlan;
    try {
      freshPlan = await options.previewPlan(parseAgentWriteRequest(resolved.request));
    } catch (error) {
      if (resolved.request.kind === "register-project")
        return { status: "stale", message: "The project folder or registry changed; preview registration again." };
      throw error;
    }
    if (!samePlan(resolved.plan, freshPlan))
      return { status: "stale" as const, message: "The files changed; preview again." };
    if (freshPlan.kind === "assign")
      return { status: "stale" as const, message: "The saved assignment must be previewed again." };
    const applied = await applySingleOperation(resolved, freshPlan, options);
    if (applied?.status === "stale" || (applied?.status === "failed" && !applied.receipts?.length)) return applied;
    if (!applied) return { status: "failed" as const, message: "The operation did not produce a receipt." };
    const receipts = applied.receipts ?? [];
    if (!receipts.length) return applied;
    const representative = applied.receipt ?? receipts.at(-1)!;
    if (!representative) return { status: "failed" as const, message: "The operation did not produce a receipt." };
    const outcome: AgentApplyOutcome = {
      status: applied.status,
      ...(applied.status === "failed" && "message" in applied ? { message: errorMessage(applied.message) } : {}),
    } as const;
    await options.requests.recordApplyOutcome(
      requestId,
      receipts.map((receipt) => receipt.operationId),
      outcome,
      consent,
      lease.leaseId,
    );
    return {
      status: applied.status,
      receipt: representative,
      ...(representative.kind === "register-project" && representative.project
        ? { projectId: representative.project.id }
        : {}),
      ...(receipts.length > 1 ? { receipts } : {}),
      ...(outcome.status === "failed" && "message" in outcome ? { message: outcome.message } : {}),
    };
  } finally {
    await options.requests.releaseApplyAuthorization(requestId, lease.leaseId);
  }
}

function applyWaitMs(value: unknown): number {
  if (value === undefined) return 10 * 60 * 1000;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 50_000)
    throw fail("waitMs must be an integer between 0 and 50000.");
  return value;
}

export function createAgentApply(options: ApplyOptions): (params: unknown, client: AgentClient) => Promise<unknown> {
  const inFlight = new Map<string, Promise<unknown>>();
  return (params: unknown, _client: AgentClient) => {
    const value = object(params, "apply parameters");
    keys(value, ["requestId", "waitMs"], "apply parameters");
    applyWaitMs(value.waitMs);
    const requestId = id(value.requestId, "Request id");
    return options.requests.get(requestId).then((request) => {
      // Waiting clients have independent deadlines; only actual writes share one execution.
      if (request?.status === "pending") return executeApply(params, options);
      const active = inFlight.get(requestId);
      if (active) return active;
      const task = executeApply(params, options).finally(() => inFlight.delete(requestId));
      inFlight.set(requestId, task);
      return task;
    });
  };
}
