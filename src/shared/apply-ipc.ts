import type { HarnessId } from "../domain/harness-targets";
import type { AssignmentActionState } from "../domain/assignment-plan";
import { parseApplyOperationResponse } from "./operations-ipc";

export const APPLY_IPC_CHANNELS = {
  preview: "omni:apply:preview",
  run: "omni:apply:run",
  removePreview: "omni:apply:remove-preview",
  removeRun: "omni:apply:remove-run",
  restorePreview: "omni:apply:restore-preview",
  restoreRun: "omni:apply:restore-run",
} as const;

export type ApplyPreviewRequest = Readonly<{
  projectId: string;
  grantHandle: string;
  sourceGrantHandle: string;
  bindingIds?: readonly string[];
}>;
export type ApplyResolution = Readonly<{ actionId: string; choice: "keep-mine" | "take-marketplace" }>;
export type ApplyRunRequest = Readonly<{ planId: string; resolutions: readonly ApplyResolution[] }>;
export type RemovePreviewRequest = Readonly<{ bindingId: string; grantHandle: string }>;
export type RemoveRunRequest = Readonly<{ planId: string; operationId?: string }>;
export type RestorePreviewRequest = Readonly<{ operationId: string }>;
export type RestoreRunRequest = Readonly<{ planId: string }>;

export type ApplyPreviewAction = Readonly<{
  actionId: string;
  bindingId: string;
  harnessId: HarnessId;
  kind: string;
  relativePath: string;
  state: AssignmentActionState;
  reason?: string;
  needsResolution: boolean;
  diff?: Readonly<{ kind: "unified"; text: string; truncated: boolean }>;
}>;
export type ApplyGitPreview = Readonly<{
  mode: "commit" | "not-a-repository" | "disabled" | "unavailable";
  head?: string;
}>;
export type ApplyPreviewResponse = Readonly<{
  status: "ready";
  planId: string;
  project: Readonly<{ displayName: string }>;
  actions: readonly ApplyPreviewAction[];
  git: ApplyGitPreview;
}>;
export type ApplyBlockedResponse = Readonly<{ status: "blocked"; reason: string; diagnostic?: string }>;
export type ApplyRunResponse = Readonly<{
  status: "applied" | "failed";
  receipt: import("./operations-ipc").OperationReceipt;
}>;
export type RemovePreviewAction = Readonly<{
  relativePath: string;
  contentHash: string;
  modified: boolean;
  diff?: Readonly<{ kind: "unified"; text: string; truncated: boolean }>;
}>;
export type RemovePreviewResponse = Readonly<{
  status: "ready";
  planId: string;
  project: Readonly<{ displayName: string }>;
  unit: Readonly<{ id: string; harnessId: HarnessId }>;
  files: readonly RemovePreviewAction[];
  notes?: readonly string[];
  git: ApplyGitPreview;
}>;
export type RestorePreviewResponse = Readonly<{
  status: "ready";
  planId: string;
  project: Readonly<{ id: string }>;
  files: readonly Readonly<{ relativePath: string; action: "delete" | "restore" }>[];
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}
function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value.trim();
}
function path(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${label} is invalid.`);
  return value.replaceAll("\\", "/");
}
function hashId(value: unknown, label: string): string {
  return text(value, label);
}
function responseRecord(value: unknown, label: string): Record<string, unknown> {
  return record(value, label);
}

export function parseApplyPreviewRequest(value: unknown): ApplyPreviewRequest {
  const request = record(value, "Apply preview request");
  keys(request, ["projectId", "grantHandle", "sourceGrantHandle", "bindingIds"], "Apply preview request");
  if (request.bindingIds !== undefined && (!Array.isArray(request.bindingIds) || request.bindingIds.length === 0))
    throw new Error("Selected binding ids must be a non-empty array.");
  const bindingIds = request.bindingIds?.map((value) => text(value, "Binding id"));
  if (bindingIds && new Set(bindingIds).size !== bindingIds.length)
    throw new Error("Selected binding ids must be unique.");
  return {
    projectId: text(request.projectId, "Project id"),
    grantHandle: hashId(request.grantHandle, "Grant handle"),
    sourceGrantHandle: hashId(request.sourceGrantHandle, "Source grant handle"),
    ...(bindingIds ? { bindingIds } : {}),
  };
}
export function parseApplyRunRequest(value: unknown): ApplyRunRequest {
  const request = record(value, "Apply run request");
  keys(request, ["planId", "resolutions"], "Apply run request");
  if (!Array.isArray(request.resolutions)) throw new Error("Apply resolutions must be an array.");
  return {
    planId: hashId(request.planId, "Plan id"),
    resolutions: request.resolutions.map((raw) => {
      const resolution = record(raw, "Apply resolution");
      keys(resolution, ["actionId", "choice"], "Apply resolution");
      if (resolution.choice !== "keep-mine" && resolution.choice !== "take-marketplace")
        throw new Error("Apply choice is invalid.");
      return { actionId: hashId(resolution.actionId, "Action id"), choice: resolution.choice };
    }),
  };
}
export function parseRemovePreviewRequest(value: unknown): RemovePreviewRequest {
  const request = record(value, "Remove preview request");
  keys(request, ["bindingId", "grantHandle"], "Remove preview request");
  return { bindingId: text(request.bindingId, "Binding id"), grantHandle: hashId(request.grantHandle, "Grant handle") };
}
export function parseRemoveRunRequest(value: unknown): RemoveRunRequest {
  const request = record(value, "Remove run request");
  keys(request, ["planId", "operationId"], "Remove run request");
  return {
    planId: hashId(request.planId, "Plan id"),
    ...(request.operationId === undefined ? {} : { operationId: text(request.operationId, "Operation id") }),
  };
}
export function parseRestorePreviewRequest(value: unknown): RestorePreviewRequest {
  const request = record(value, "Restore preview request");
  keys(request, ["operationId"], "Restore preview request");
  return { operationId: text(request.operationId, "Operation id") };
}
export function parseRestoreRunRequest(value: unknown): RestoreRunRequest {
  const request = record(value, "Restore run request");
  keys(request, ["planId"], "Restore run request");
  return { planId: hashId(request.planId, "Plan id") };
}

export function parseApplyPreviewResponse(value: unknown): ApplyPreviewResponse | ApplyBlockedResponse {
  const response = responseRecord(value, "Apply preview response");
  if (response.status === "blocked")
    return {
      status: "blocked",
      reason: text(response.reason, "Block reason"),
      ...(response.diagnostic === undefined ? {} : { diagnostic: text(response.diagnostic, "Diagnostic") }),
    };
  if (response.status !== "ready") throw new Error("Apply preview response is invalid.");
  return value as ApplyPreviewResponse;
}
export function parseApplyMutationResponse(value: unknown): ApplyRunResponse | ApplyBlockedResponse {
  const response = responseRecord(value, "Apply response");
  if (response.status === "blocked")
    return {
      status: "blocked",
      reason: text(response.reason, "Block reason"),
      ...(response.diagnostic === undefined ? {} : { diagnostic: text(response.diagnostic, "Diagnostic") }),
    };
  if (response.status !== "applied" && response.status !== "failed") throw new Error("Apply response is invalid.");
  return { status: response.status, receipt: parseApplyOperationResponse(response).receipt } as ApplyRunResponse;
}
export function parseRemovePreviewResponse(value: unknown): RemovePreviewResponse | ApplyBlockedResponse {
  const response = responseRecord(value, "Remove preview response");
  if (response.status === "blocked")
    return {
      status: "blocked",
      reason: text(response.reason, "Block reason"),
      ...(response.diagnostic === undefined ? {} : { diagnostic: text(response.diagnostic, "Diagnostic") }),
    };
  keys(response, ["status", "planId", "project", "unit", "files", "git", "notes"], "Remove preview response");
  if (response.status !== "ready" || !Array.isArray(response.files))
    throw new Error("Remove preview response is invalid.");
  const files = response.files.map((raw) => {
    const file = record(raw, "Remove preview file");
    keys(file, ["relativePath", "contentHash", "modified", "diff"], "Remove preview file");
    if (
      typeof file.modified !== "boolean" ||
      typeof file.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.contentHash)
    )
      throw new Error("Remove preview file state is invalid.");
    let diff: RemovePreviewAction["diff"];
    if (file.diff !== undefined) {
      const value = record(file.diff, "Remove preview diff");
      keys(value, ["kind", "text", "truncated"], "Remove preview diff");
      if (value.kind !== "unified" || typeof value.text !== "string" || typeof value.truncated !== "boolean")
        throw new Error("Remove preview diff is invalid.");
      diff = { kind: "unified", text: value.text, truncated: value.truncated };
    }
    return {
      relativePath: path(file.relativePath, "Relative path"),
      contentHash: file.contentHash,
      modified: file.modified,
      ...(diff ? { diff } : {}),
    };
  });
  if (
    response.notes !== undefined &&
    (!Array.isArray(response.notes) || response.notes.some((note) => typeof note !== "string"))
  )
    throw new Error("Remove preview notes are invalid.");
  return { ...(value as RemovePreviewResponse), files };
}
export function parseRestorePreviewResponse(value: unknown): RestorePreviewResponse | ApplyBlockedResponse {
  const response = responseRecord(value, "Restore preview response");
  if (response.status === "blocked")
    return {
      status: "blocked",
      reason: text(response.reason, "Block reason"),
      ...(response.diagnostic === undefined ? {} : { diagnostic: text(response.diagnostic, "Diagnostic") }),
    };
  if (response.status !== "ready") throw new Error("Restore preview response is invalid.");
  return value as RestorePreviewResponse;
}

export interface ApplyDesktopApi {
  previewApply(request: ApplyPreviewRequest): Promise<ApplyPreviewResponse | ApplyBlockedResponse>;
  runApply(request: ApplyRunRequest): Promise<ApplyRunResponse | ApplyBlockedResponse>;
  previewRemove(request: RemovePreviewRequest): Promise<RemovePreviewResponse | ApplyBlockedResponse>;
  runRemove(request: RemoveRunRequest): Promise<ApplyRunResponse | ApplyBlockedResponse>;
  previewRestoreApply(request: RestorePreviewRequest): Promise<RestorePreviewResponse | ApplyBlockedResponse>;
  runRestoreApply(request: RestoreRunRequest): Promise<ApplyRunResponse | ApplyBlockedResponse>;
}
