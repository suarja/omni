import { parseProjectSkills, parseProjectSkillsRequest } from "../../shared/project-skills-ipc";
import { ipcMain } from "electron";

import type { SkillManagementService } from "../../application/skill-management";
import type { AgentRequestsStore } from "../agent-gateway/requests-store";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import {
  parseReadSkillVariantOriginRequest,
  parseReadSkillVariantOriginResponse,
} from "../../shared/skill-variant-effects";
import { parseWriteSkillRequest } from "../../shared/operations-write-skill-ipc";
import { parseEmptyOperationsRequest } from "../../shared/operations-ipc";
import { safeDiagnostic } from "../operations-ipc-helpers";
import {
  SKILL_MANAGEMENT_IPC_CHANNELS,
  parseSkillManagementApplyRequest,
  parseSkillManagementPreviewRequest,
  parseSkillManagementRefreshRequest,
  parseSkillManagementResultRequest,
  parseSkillPreview,
  parseSkillResult,
  parseSkillIntent,
  type SkillManagementDesktopApi,
} from "../../shared/skill-management-ipc";
import {
  parseSkillPropagationCandidates,
  parseSkillPropagationCandidatesRequest,
} from "../../shared/skill-propagation-ipc";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;

export function registerSkillManagementIpcHandlers(
  assertTrustedSender: SenderGuard,
  service: SkillManagementService,
  requests?: AgentRequestsStore,
  readOrigin?: (
    source: SourceSkillRef,
  ) => Promise<import("../../shared/skill-variant-effects").ReadSkillVariantOriginResponse>,
): Pick<
  SkillManagementDesktopApi,
  | "previewSkillOperation"
  | "refreshSkillOperation"
  | "applySkillOperation"
  | "readSkillOperationResult"
  | "listSkillOperationRecoveries"
  | "readSkillPropagationCandidates"
  | "readSkillVariantOrigin"
  | "readProjectSkills"
> {
  const guard =
    <T>(handler: (request: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, request: unknown): Promise<T> => {
      assertTrustedSender(event);
      try {
        return await handler(request);
      } catch (error: unknown) {
        throw new Error(safeDiagnostic(error));
      }
    };
  const actorFor = async (
    requestId: string | undefined,
    intent?: import("../../shared/skill-management-ipc").SkillIntent,
    intentId?: string,
  ) => {
    if (!requestId) return { kind: "desktop" as const };
    if (!requests) throw new Error("Agent request authorization is unavailable.");
    const pending = await requests.get(requestId);
    if (!pending) throw new Error("Agent skill request is unavailable.");
    if (intentId && pending.intentId !== intentId)
      throw new Error("Agent request does not match this skill operation.");
    if (intent) {
      const parsedIntent = parseSkillIntent(intent);
      const matchesLinkedIntent =
        pending.skillIntent && JSON.stringify(pending.skillIntent) === JSON.stringify(parsedIntent);
      const matchesLegacyWrite =
        !pending.skillIntent &&
        pending.request.kind === "write-skill" &&
        parsedIntent.kind === "write" &&
        JSON.stringify({
          ...parseWriteSkillRequest(pending.request),
          files: [...pending.request.files].sort((left, right) => left.path.localeCompare(right.path)),
        }) ===
          JSON.stringify({
            ...parseWriteSkillRequest(parsedIntent.request),
            files: [...parsedIntent.request.files].sort((left, right) => left.path.localeCompare(right.path)),
          });
      if (!matchesLinkedIntent && !matchesLegacyWrite)
        throw new Error("Agent skill request does not match this draft.");
    }
    if (intentId && !pending.skillIntent) throw new Error("Agent skill request does not match this draft.");
    const provenance = pending.request.kind === "write-skill" ? pending.request.agent : undefined;
    return {
      kind: "mcp" as const,
      requestId,
      ...((pending.harness ?? provenance?.harness) ? { harness: pending.harness ?? provenance?.harness } : {}),
      ...((pending.sessionName ?? provenance?.sessionName)
        ? { sessionName: pending.sessionName ?? provenance?.sessionName }
        : {}),
    };
  };
  const previewSkillOperation = async (raw: unknown) => {
    const request = parseSkillManagementPreviewRequest(raw);
    const actor = await actorFor(request.requestId, request.intent);
    if (request.requestId) {
      const pending = await requests!.get(request.requestId);
      if (pending?.intentId) return parseSkillPreview(await service.refresh(pending.intentId, actor));
    }
    const preview = parseSkillPreview(await service.preview(request.intent, actor));
    if (request.requestId && preview.status === "ready")
      await requests!.linkSkillIntent(request.requestId, preview.intentId, request.intent);
    return preview;
  };
  const refreshSkillOperation = async (raw: unknown) => {
    const request = parseSkillManagementRefreshRequest(raw);
    const actor = await actorFor(request.requestId, undefined, request.intentId);
    return parseSkillPreview(await service.refresh(request.intentId, actor));
  };
  const applySkillOperation = async (raw: unknown) => {
    const request = parseSkillManagementApplyRequest(raw);
    let lease: Awaited<ReturnType<AgentRequestsStore["acquireApplyAuthorization"]>> | undefined;
    try {
      let authorization: import("../../shared/skill-management-ipc").SkillAuthorization;
      if (request.requestId) {
        if (!requests) throw new Error("Agent request authorization is unavailable.");
        const pending = await requests.get(request.requestId);
        if (!pending || pending.intentId !== request.intentId || !pending.skillIntent)
          throw new Error("Agent skill request is unavailable or does not match this operation.");
        lease = await requests.acquireApplyAuthorization(request.requestId);
        authorization = {
          kind: "agent",
          requestId: request.requestId,
          leaseId: lease.leaseId,
          approvedAt: lease.approvedAt,
          effectFingerprint: request.effectFingerprint,
          approval: pending.approval,
        };
      } else {
        authorization = {
          kind: "desktop",
          effectFingerprint: request.effectFingerprint,
          approvedAt: new Date().toISOString(),
        };
      }
      const result = parseSkillResult(await service.apply(request.intentId, authorization));
      if (result.status === "applying") throw new Error("The skill operation has not reached its final outcome.");
      if (request.requestId && lease) {
        const pending = await requests!.get(request.requestId);
        if (!pending) throw new Error("Agent request disappeared before its result was recorded.");
        const harness =
          pending.harness ?? (pending.request.kind === "write-skill" ? pending.request.agent?.harness : undefined);
        const sessionName =
          pending.sessionName ??
          (pending.request.kind === "write-skill" ? pending.request.agent?.sessionName : undefined);
        await requests!.recordApplyOutcome(
          request.requestId,
          result.receiptIds,
          {
            status: result.status,
            ...(["failed", "partial", "recovery-required", "cancelled"].includes(result.status)
              ? { message: result.issues[0]?.message ?? "The skill operation failed." }
              : {}),
          },
          {
            mode: pending.approval,
            at: lease.approvedAt,
            ...(harness ? { harness } : {}),
            ...(sessionName ? { sessionName } : {}),
          },
          lease.leaseId,
        );
        lease = undefined;
      }
      return result;
    } finally {
      if (request.requestId && lease) await requests?.releaseApplyAuthorization(request.requestId, lease.leaseId);
    }
  };
  const readSkillOperationResult = async (raw: unknown) => {
    const request = parseSkillManagementResultRequest(raw);
    const result = await service.readResult(request.intentId);
    return result === undefined ? undefined : parseSkillResult(result);
  };
  const listSkillOperationRecoveries = async (raw: unknown = {}) => {
    parseEmptyOperationsRequest(raw);
    return (await service.listRecoveries()).map(parseSkillResult);
  };
  const readSkillVariantOrigin = async (raw: unknown) => {
    const request = parseReadSkillVariantOriginRequest(raw);
    const response = readOrigin
      ? await readOrigin(request.source)
      : { status: "unavailable" as const, reason: "The personal source origin reader is unavailable." };
    return parseReadSkillVariantOriginResponse(response, request.source);
  };
  const readSkillPropagationCandidates = async (raw: unknown) => {
    const source = parseSkillPropagationCandidatesRequest(raw);
    if (!service.readPropagationCandidates) throw new Error("Skill propagation candidates are unavailable.");
    return parseSkillPropagationCandidates(await service.readPropagationCandidates(source));
  };
  const readProjectSkills = async (raw: unknown) => {
    const { projectId } = parseProjectSkillsRequest(raw);
    if (!service.readProjectSkills) throw new Error("Project skills are unavailable.");
    return parseProjectSkills(await service.readProjectSkills(projectId));
  };
  ipcMain.handle(SKILL_MANAGEMENT_IPC_CHANNELS.projectSkills, guard(readProjectSkills));
  ipcMain.handle(SKILL_MANAGEMENT_IPC_CHANNELS.recoveries, guard(listSkillOperationRecoveries));
  ipcMain.handle(SKILL_MANAGEMENT_IPC_CHANNELS.preview, guard(previewSkillOperation));
  ipcMain.handle(SKILL_MANAGEMENT_IPC_CHANNELS.refresh, guard(refreshSkillOperation));
  ipcMain.handle(SKILL_MANAGEMENT_IPC_CHANNELS.apply, guard(applySkillOperation));
  ipcMain.handle(SKILL_MANAGEMENT_IPC_CHANNELS.result, guard(readSkillOperationResult));
  ipcMain.handle(SKILL_MANAGEMENT_IPC_CHANNELS.variantOrigin, guard(readSkillVariantOrigin));
  ipcMain.handle(SKILL_MANAGEMENT_IPC_CHANNELS.propagationCandidates, guard(readSkillPropagationCandidates));
  return {
    readProjectSkills: async (projectId) => readProjectSkills({ projectId }),
    previewSkillOperation,
    refreshSkillOperation,
    applySkillOperation,
    readSkillOperationResult,
    listSkillOperationRecoveries,
    readSkillVariantOrigin,
    readSkillPropagationCandidates: async (source) => readSkillPropagationCandidates({ source }),
  };
}
