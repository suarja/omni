import type { OperationReceipt } from "./operations-ipc";

export type AgentApplyOutcome = Readonly<{
  status: "applied" | "failed" | "no-op" | "partial" | "recovery-required" | "restored" | "cancelled";
  message?: string;
}>;

export type AgentResolveRequest =
  | Readonly<{ requestId: string; operationId: string }>
  | Readonly<{
      requestId: string;
      operationIds: readonly string[];
      outcome: AgentApplyOutcome;
      approvedAt?: string;
      leaseId?: string;
    }>;

export type AgentApplyAuthorization = Readonly<{ leaseId: string; approvedAt: string }>;
export type AgentBeginApplyRequest = Readonly<{ requestId: string }>;
export type AgentEndApplyRequest = Readonly<{ requestId: string; leaseId: string }>;

export type AgentReceiptResponse =
  | Readonly<{ status: "found"; receipt: OperationReceipt; receipts?: readonly OperationReceipt[] }>
  | Readonly<{ status: "none"; message: string }>
  | Readonly<{ status: "missing"; message?: string; missingReceiptIds?: readonly string[] }>;

export type AgentTerminalReferences = Readonly<{
  receiptIds?: readonly string[];
  applyOutcome?: AgentApplyOutcome;
}>;
export type AgentReceiptRequest = Readonly<{ operationId?: string; requestId?: string }>;

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function id(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.trim())
  )
    throw new Error(`${label} is invalid.`);
  return value.trim();
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 40) throw new Error(`${label} is invalid.`);
  try {
    if (new Date(value).toISOString() !== value) throw new Error(`${label} is invalid.`);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function outcome(value: unknown): AgentApplyOutcome {
  const item = record(value, "Agent apply outcome");
  keys(item, ["status", "message"], "Agent apply outcome");
  const outcomes = ["applied", "failed", "no-op", "partial", "recovery-required", "restored", "cancelled"];
  if (!outcomes.includes(String(item.status))) throw new Error("Agent apply outcome is invalid.");
  if (item.message !== undefined) {
    if (
      !["failed", "partial", "recovery-required", "cancelled"].includes(String(item.status)) ||
      typeof item.message !== "string" ||
      !item.message.trim() ||
      item.message.length > 2000 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(item.message)
    )
      throw new Error("Agent apply outcome message is invalid.");
  }
  return {
    status: item.status as AgentApplyOutcome["status"],
    ...(item.message === undefined ? {} : { message: item.message.trim() }),
  };
}

export function parseAgentResolveRequest(value: unknown): AgentResolveRequest {
  const request = record(value, "Agent resolve request");
  const requestId = id(request.requestId, "Request id");
  if ("operationIds" in request || "outcome" in request) {
    keys(request, ["requestId", "operationIds", "outcome", "approvedAt", "leaseId"], "Agent resolve request");
    if (!Array.isArray(request.operationIds) || request.operationIds.length === 0 || request.operationIds.length > 1000)
      throw new Error("Operation ids are invalid.");
    const operationIds = request.operationIds.map((item) => id(item, "Operation id"));
    if (new Set(operationIds).size !== operationIds.length) throw new Error("Operation ids must be unique.");
    return {
      requestId,
      operationIds,
      outcome: outcome(request.outcome),
      ...(request.approvedAt === undefined ? {} : { approvedAt: iso(request.approvedAt, "Approval time") }),
      ...(request.leaseId === undefined ? {} : { leaseId: id(request.leaseId, "Apply lease id") }),
    };
  }
  keys(request, ["requestId", "operationId"], "Agent resolve request");
  return { requestId, operationId: id(request.operationId, "Operation id") };
}

export function parseAgentBeginApplyRequest(value: unknown): AgentBeginApplyRequest {
  const request = record(value, "Agent begin apply request");
  keys(request, ["requestId"], "Agent begin apply request");
  return { requestId: id(request.requestId, "Request id") };
}

export function parseAgentEndApplyRequest(value: unknown): AgentEndApplyRequest {
  const request = record(value, "Agent end apply request");
  keys(request, ["requestId", "leaseId"], "Agent end apply request");
  return {
    requestId: id(request.requestId, "Request id"),
    leaseId: id(request.leaseId, "Apply lease id"),
  };
}

export function parseAgentApplyAuthorization(value: unknown): AgentApplyAuthorization {
  const authorization = record(value, "Agent apply authorization");
  keys(authorization, ["leaseId", "approvedAt"], "Agent apply authorization");
  return {
    leaseId: id(authorization.leaseId, "Apply lease id"),
    approvedAt: iso(authorization.approvedAt, "Approval time"),
  };
}

export function parseAgentDeclineRequest(value: unknown): Readonly<{ requestId: string }> {
  const request = record(value, "Agent decline request");
  keys(request, ["requestId"], "Agent decline request");
  return { requestId: id(request.requestId, "Request id") };
}

export function parseAgentReceiptRequest(value: unknown): AgentReceiptRequest {
  const request = record(value, "Agent receipt request");
  keys(request, ["operationId", "requestId"], "Agent receipt request");
  if ((request.operationId === undefined) === (request.requestId === undefined))
    throw new Error("Provide operationId or requestId.");
  return {
    ...(request.operationId === undefined ? {} : { operationId: id(request.operationId, "Operation id") }),
    ...(request.requestId === undefined ? {} : { requestId: id(request.requestId, "Request id") }),
  };
}

export function parseAgentApplyOutcome(value: unknown): AgentApplyOutcome {
  return outcome(value);
}

export function parseAgentTerminalReferences(
  status: unknown,
  receiptId: unknown,
  receiptIdsValue: unknown,
  applyOutcomeValue: unknown,
): AgentTerminalReferences {
  const receiptIds =
    receiptIdsValue === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(receiptIdsValue)) throw new Error("Receipt ids must be an array.");
          const parsed = receiptIdsValue.map((value) => id(value, "Receipt id"));
          if (new Set(parsed).size !== parsed.length) throw new Error("Receipt ids must be unique.");
          return parsed;
        })();
  const applyOutcome = applyOutcomeValue === undefined ? undefined : outcome(applyOutcomeValue);
  if (receiptIds !== undefined && !applyOutcome) throw new Error("Agent apply outcome references are invalid.");
  if (applyOutcome !== undefined) {
    const noReceipt =
      ["no-op", "failed", "recovery-required", "cancelled"].includes(applyOutcome.status) &&
      receiptIds?.length === 0 &&
      receiptId === undefined;
    const receipted = Boolean(receiptIds?.length) && receiptId === receiptIds?.at(-1);
    if (status !== "approved" || (!noReceipt && !receipted)) throw new Error("Agent apply outcome is inconsistent.");
  }
  return { ...(receiptIds ? { receiptIds } : {}), ...(applyOutcome ? { applyOutcome } : {}) };
}
