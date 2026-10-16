import { randomUUID } from "node:crypto";

import type { SkillManagementService } from "../../application/skill-management";
import type { SkillIntent, SkillPreview } from "../../shared/skill-management-ipc";
import type { AgentPlan, AgentWriteRequest, StoredAgentWriteRequest } from "../../shared/agents-ipc";
import type { OperationPlan } from "../../shared/operations-ipc";
import type { RegistryIpcServices } from "../registry-ipc";
import type { Settings } from "../../shared/settings-ipc";
import type { AgentRequestsStore } from "./requests-store";
import type { AgentClient } from "./server";
import type { OperationStore } from "../operation-store";
import { deriveApprovalInput, resolveApproval } from "./approval";
import { displayCwd, fail } from "./router-inputs";

type ManagementPreviewOptions = Readonly<{
  service: SkillManagementService;
  registry: RegistryIpcServices;
  requests: AgentRequestsStore;
  settings: Settings;
  request: AgentWriteRequest;
  intent: SkillIntent;
  client: AgentClient;
  askInOmni?: boolean;
  now: () => number;
}>;

export function skillIntentForAgentRequest(request: StoredAgentWriteRequest): SkillIntent | undefined {
  if (request.kind === "install-external-skill") return request;
  if (request.kind === "write-skill") return { kind: "write", request };
  if (request.kind === "update-and-maintain" || request.kind === "maintain-current") return request;
  if (request.kind === "assign") {
    const harnessIds = request.harnesses ?? ["claude-code", "codex"];
    return {
      kind: "assign",
      sourceId: request.sourceId,
      packageId: request.packageId,
      ...(request.artifactPath ? { artifactPath: request.artifactPath } : {}),
      targets: request.projectIds.map((projectId) => ({ projectId, harnessIds })),
    };
  }
  if (request.kind === "remove-skill") return { kind: "remove", bindingIds: request.bindingIds };
  if (request.kind === "restore-skill") return { kind: "restore", operationId: request.operationId };
  return undefined;
}

function assignmentProjection(preview: Extract<SkillPreview, { status: "ready" }>): AgentPlan {
  const projectPlans = new Map<
    string,
    {
      projectId: string;
      planId: string;
      status: "ready";
      actions: Array<{
        bindingId: string;
        harnessId: "claude-code" | "codex" | "cursor";
        kind: import("../../domain/assignment-plan").Binding["kind"];
        relativePath: string;
        state: "add" | "current" | "update";
      }>;
    }
  >();
  const bindings = preview.steps.flatMap((step) =>
    step.bindingEffects.flatMap((effect) => (effect.after ? [effect.after] : [])),
  );
  for (const step of preview.steps) {
    for (const effect of step.bindingEffects) {
      const binding = effect.after ?? effect.before;
      if (!binding) continue;
      const change = step.files.find(
        (file) => file.rootId === binding.projectId && file.change !== "unchanged",
      )?.change;
      const state = !effect.before ? "add" : change === "change" || change === "add" ? "update" : "current";
      const projectPlan = projectPlans.get(binding.projectId) ?? {
        projectId: binding.projectId,
        planId: step.plan.planId,
        status: "ready" as const,
        actions: [],
      };
      projectPlan.actions.push({
        bindingId: binding.bindingId,
        harnessId: binding.harnessId,
        kind: binding.kind,
        relativePath: binding.artifactPath,
        state,
      });
      projectPlans.set(binding.projectId, projectPlan);
    }
  }
  return { kind: "assign", plans: [...projectPlans.values()], bindings };
}

function operationProjection(preview: Extract<SkillPreview, { status: "ready" }>): OperationPlan {
  const first = preview.steps[0]?.plan;
  if (!first && preview.propagation)
    return {
      planId: preview.planId,
      kind: "propagate-skill",
      displayTarget: `${preview.propagation.source.packageId}/${preview.propagation.source.artifactPath}`,
      actions: [],
      git: { mode: "disabled", warnings: [] },
      visibleIn: ["omni"],
    };
  if (!first) throw fail("The skill preview did not contain an operation step.");
  return first;
}

export function planFor(preview: Extract<SkillPreview, { status: "ready" }>, intent: SkillIntent): AgentPlan {
  return intent.kind === "assign" ? assignmentProjection(preview) : operationProjection(preview);
}

export async function previewManagedSkill(
  options: ManagementPreviewOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const requestId = randomUUID();
  const actor = {
    kind: "mcp" as const,
    requestId,
    ...(options.client.harness ? { harness: options.client.harness } : {}),
    ...(options.client.sessionName ? { sessionName: options.client.sessionName } : {}),
  };
  const preview = await options.service.preview(options.intent, actor);
  if (preview.status !== "ready") return preview;
  const plan = planFor(preview, options.intent);
  const decision = await resolveApproval({
    registry: options.registry,
    ...deriveApprovalInput(options.intent, preview),
    settings: options.settings,
    askInOmni: options.askInOmni,
  });
  const approval = decision.mode;
  const stored = await options.requests.create({
    requestId,
    intentId: preview.intentId,
    skillIntent: options.intent,
    request: options.request,
    plan,
    approval,
    ...(decision.reason ? { approvalReason: decision.reason } : {}),
    ...(options.client.harness ? { harness: options.client.harness } : {}),
    ...(options.client.sessionName ? { sessionName: options.client.sessionName } : {}),
    ...(options.client.cwd ? { cwd: displayCwd(options.client.cwd) } : {}),
    createdAt: new Date(options.now()).toISOString(),
  });
  return {
    requestId: stored.requestId,
    intentId: preview.intentId,
    plan,
    skillPreview: preview,
    approval,
    ...(decision.reason ? { approvalReason: decision.reason } : {}),
    ...(options.intent.kind === "write" && preview.scope.targets.length === 0 ? { sourceOnly: true } : {}),
  };
}

export async function applyManagedSkill(
  args: Readonly<{
    request: import("../../shared/agents-ipc").AgentRequest;
    service: SkillManagementService;
    requests: AgentRequestsStore;
    operationStore: OperationStore;
  }>,
): Promise<unknown> {
  const request = args.request;
  const intentId = request.intentId;
  const intent = skillIntentForAgentRequest(request.request);
  if (!intentId || !intent || !request.skillIntent || JSON.stringify(intent) !== JSON.stringify(request.skillIntent))
    return { status: "failed", message: "The saved skill request does not match its managed operation." };
  const lease = await args.requests.acquireApplyAuthorization(request.requestId);
  try {
    const harness =
      request.harness ?? (request.request.kind === "write-skill" ? request.request.agent?.harness : undefined);
    const sessionName =
      request.sessionName ?? (request.request.kind === "write-skill" ? request.request.agent?.sessionName : undefined);
    const actor = {
      kind: "mcp" as const,
      requestId: request.requestId,
      ...(harness ? { harness } : {}),
      ...(sessionName ? { sessionName } : {}),
    };
    let result = await args.service.readResult(intentId);
    if (result) result = await verifiedSkillResult(result, args.operationStore);
    else {
      const fresh = await args.service.refresh(intentId, actor);
      if (fresh.status !== "ready")
        return {
          status: "stale",
          message: fresh.status === "stale" ? "The files changed; preview again." : fresh.reason,
          details: fresh.details,
        };
      result = await args.service.apply(intentId, {
        kind: "agent",
        requestId: request.requestId,
        leaseId: lease.leaseId,
        approvedAt: lease.approvedAt,
        effectFingerprint: fresh.effectFingerprint,
        approval: request.approval,
      });
    }
    const outcome =
      result.status === "no-op"
        ? { status: "no-op" as const }
        : result.status === "applied" || result.status === "restored"
          ? { status: result.status as "applied" | "restored" }
          : {
              status: result.status as "failed" | "partial" | "recovery-required" | "cancelled",
              ...(result.issues[0]?.message ? { message: result.issues[0].message } : {}),
            };
    await args.requests.recordApplyOutcome(
      request.requestId,
      result.receiptIds,
      outcome,
      {
        mode: request.approval,
        at: lease.approvedAt,
        ...(harness ? { harness } : {}),
        ...(sessionName ? { sessionName } : {}),
      },
      lease.leaseId,
    );
    return result;
  } finally {
    await args.requests.releaseApplyAuthorization(request.requestId, lease.leaseId);
  }
}

export async function verifiedSkillResult(
  result: import("../../shared/skill-management-ipc").SkillResult,
  operationStore: OperationStore,
): Promise<import("../../shared/skill-management-ipc").SkillResult> {
  if (!result.receiptIds.length) return result;
  const loaded = await operationStore.read();
  if (loaded.status !== "ready")
    return recoveryForMissingReceipts(result, "Operation history is unavailable; do not repeat this request's writes.");
  const receipts = result.receiptIds.flatMap((id) => loaded.receipts.filter((receipt) => receipt.operationId === id));
  if (receipts.length !== result.receiptIds.length)
    return recoveryForMissingReceipts(
      result,
      "A recorded operation receipt is missing; inspect recovery before continuing.",
    );
  return { ...result, receipts };
}

function recoveryForMissingReceipts(
  result: import("../../shared/skill-management-ipc").SkillResult,
  message: string,
): import("../../shared/skill-management-ipc").SkillResult {
  return {
    ...result,
    status: "recovery-required",
    issues: [...result.issues, { code: "receipt-unavailable", message, recoveryAction: "inspect-recovery" }],
    recoveryAvailable: true,
  };
}
