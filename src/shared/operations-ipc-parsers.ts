import {
  registerProjectSchema,
  parseProjectRegistrationPlan,
  type RegisterProjectRequest,
} from "./project-registration-ipc";
import {
  parsePublishPluginRequest,
  parseCreateStorefrontRequest,
  parseRetryPushRequest,
  conflictChoicesSchema,
  parsePublicationPlanSummary,
  type PublishPluginRequest,
  type CreateStorefrontRequest,
  type RetryPushRequest,
} from "./publication-operations-ipc";
import { parseDescribePluginRequest, type DescribePluginRequest } from "./plugin-description-ipc";
import { parseDisconnectAgentsRequest, type DisconnectAgentsRequest } from "./agent-maintenance-ipc";
import {
  assertKeys,
  assertRecord,
  readDisplay,
  readDisplayPath,
  readHash,
  readOpaque,
  readRelativePath,
  readText,
} from "./operations-ipc-parser-utils";
import type { EntryKind } from "../domain/project-source-registry";
import { parseImportOperationRequest, type ImportOperationRequest } from "./operations-import-ipc";
import { parseWriteSkillRequest, type WriteSkillRequest } from "./operations-write-skill-ipc";
import { parseRegisterMcpRequest, type RegisterMcpRequest } from "./operations-register-mcp-ipc";
import {
  parseCompatibilityReport,
  parsePreviewCompatibleRequest,
  type PreviewCompatibleRequest,
} from "./operations-compatible-ipc";
import type {
  ApplyOperationRequest,
  ApplyOperationResponse,
  OperationAction,
  OperationKind,
  OperationPlan,
  PickParentResponse,
  PreviewMarketplaceRequest,
  PreviewApplyPlanRequest,
  PreviewMarketplaceResponse,
} from "./operations-ipc";
import { OPERATION_KINDS } from "./operations-ipc";
import { parseInstallAgentsRequest, type InstallAgentsRequest } from "./operations-install-agents-ipc";
import { parseWriteHarnessSettingRequest, type WriteHarnessSettingRequest } from "./operations-harness-setting-ipc";
import { parseAddToProjectRequest, type AddToProjectRequest } from "./operations-add-to-project-ipc";
import { parseOperationAction, parseOperationGit, parseOperationReceipt } from "./operations-receipt-parsers";
import type { ProjectPlan } from "../domain/assignment-plan";

function isOperationKind(value: unknown): value is OperationKind {
  return typeof value === "string" && (OPERATION_KINDS as readonly string[]).includes(value);
}

function parsePlan(value: unknown): OperationPlan {
  const plan = assertRecord(value, "Operation plan");
  assertKeys(
    plan,
    [
      "projectRegistration",
      "planId",
      "kind",
      "displayTarget",
      "packageId",
      "actions",
      "git",
      "visibleIn",
      "report",
      "findings",
      "notes",
      "harnesses",
      "steps",
      "publication",
    ],
    "Operation plan",
  );
  if (!isOperationKind(plan.kind)) throw new Error("Operation kind is invalid.");
  if (!Array.isArray(plan.actions)) throw new Error("Operation actions must be an array.");
  const git = parseOperationGit(plan.git);
  const visibleIn = plan.visibleIn === undefined ? undefined : parseVisibleIn(plan.visibleIn);
  const report = plan.report === undefined ? undefined : parseCompatibilityReport(plan.report);
  const findings = plan.findings === undefined ? undefined : parseFindings(plan.findings);
  const notes = plan.notes === undefined ? undefined : parseNotes(plan.notes);
  const harnesses = plan.harnesses === undefined ? undefined : parsePlanHarnesses(plan.harnesses);
  const steps = plan.steps === undefined ? undefined : parsePlanSteps(plan.steps);
  return {
    planId: readOpaque(plan.planId, "Plan id"),
    kind: plan.kind,
    displayTarget: readDisplayPath(plan.displayTarget, "Operation target"),
    ...(plan.packageId === undefined ? {} : { packageId: readRelativePath(plan.packageId) }),
    actions: plan.actions.map((action) => parseOperationAction(action) as OperationAction),
    git: { mode: git.mode, warnings: git.warnings },
    ...(plan.projectRegistration === undefined
      ? {}
      : { projectRegistration: parseProjectRegistrationPlan(plan.projectRegistration) }),
    ...(visibleIn ? { visibleIn } : {}),
    ...(report ? { report } : {}),
    ...(findings ? { findings } : {}),
    ...(notes ? { notes } : {}),
    ...(harnesses ? { harnesses } : {}),
    ...(steps ? { steps } : {}),
    ...(plan.publication === undefined ? {} : { publication: parsePublicationPlanSummary(plan.publication) }),
  };
}

function parseProjectPlan(value: unknown): ProjectPlan {
  const plan = assertRecord(value, "Assignment plan");
  assertKeys(plan, ["projectId", "planId", "status", "actions"], "Assignment plan");
  if (plan.status !== "ready" && plan.status !== "conflict" && plan.status !== "blocked")
    throw new Error("Assignment plan status is invalid.");
  if (!Array.isArray(plan.actions)) throw new Error("Assignment plan actions must be an array.");
  return {
    projectId: readOpaque(plan.projectId, "Assignment project id"),
    planId: readOpaque(plan.planId, "Assignment plan id"),
    status: plan.status,
    actions: plan.actions.map((value) => {
      const action = assertRecord(value, "Assignment action");
      assertKeys(action, ["bindingId", "harnessId", "kind", "relativePath", "state", "reason"], "Assignment action");
      if (!["claude-code", "codex", "cursor"].includes(String(action.harnessId)))
        throw new Error("Assignment harness id is invalid.");
      if (!["skill", "instruction", "command", "agent", "hook", "mcp-config"].includes(String(action.kind)))
        throw new Error("Assignment kind is invalid.");
      if (!["add", "current", "update", "linked", "conflict", "blocked"].includes(String(action.state)))
        throw new Error("Assignment action state is invalid.");
      return {
        bindingId: readOpaque(action.bindingId, "Assignment binding id"),
        harnessId: action.harnessId as ProjectPlan["actions"][number]["harnessId"],
        kind: action.kind as ProjectPlan["actions"][number]["kind"],
        relativePath: readDisplayPath(action.relativePath, "Assignment target path"),
        state: action.state as ProjectPlan["actions"][number]["state"],
        ...(action.reason === undefined ? {} : { reason: readText(action.reason, "Assignment reason") }),
      };
    }),
  };
}

function parsePlanSteps(value: unknown): NonNullable<OperationPlan["steps"]> {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Composite operation steps are invalid.");
  const steps = value.map((value) => {
    const step = assertRecord(value, "Composite operation step");
    assertKeys(step, ["kind", "plan"], "Composite operation step");
    if (step.kind === "import") return { kind: "import" as const, plan: parsePlan(step.plan) };
    if (step.kind === "assign") return { kind: "assign" as const, plan: parseProjectPlan(step.plan) };
    throw new Error("Composite operation step kind is invalid.");
  });
  if (steps[0]?.kind !== "import" || steps[1]?.kind !== "assign")
    throw new Error("Composite operation steps must be import then assign.");
  return steps;
}

function parsePlanHarnesses(value: unknown): NonNullable<OperationPlan["harnesses"]> {
  if (!Array.isArray(value)) throw new Error("Operation harness summaries are invalid.");
  return value.map((item) => {
    const summary = assertRecord(item, "Operation harness summary");
    assertKeys(summary, ["harness", "status", "mcp", "skills", "guard"], "Operation harness summary");
    if (summary.harness !== "claude-code" && summary.harness !== "codex")
      throw new Error("Operation harness is invalid.");
    if (summary.status !== "changes" && summary.status !== "nothing-to-do")
      throw new Error("Operation harness status is invalid.");
    if (summary.mcp !== "add" && summary.mcp !== "keep") throw new Error("Operation MCP summary is invalid.");
    if (summary.guard !== "add" && summary.guard !== "keep" && summary.guard !== "update")
      throw new Error("Operation guard summary is invalid.");
    const skills = assertRecord(summary.skills, "Operation skill summary");
    assertKeys(skills, ["add", "update", "keep"], "Operation skill summary");
    const names = (input: unknown): readonly string[] => {
      if (!Array.isArray(input) || input.some((name) => typeof name !== "string" || !name.trim()))
        throw new Error("Operation skill summary names are invalid.");
      if (new Set(input).size !== input.length) throw new Error("Operation skill summary names must be unique.");
      return input;
    };
    return {
      harness: summary.harness,
      status: summary.status,
      mcp: summary.mcp,
      skills: { add: names(skills.add), update: names(skills.update), keep: names(skills.keep) },
      guard: summary.guard,
    };
  });
}

function parseNotes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((note) => typeof note !== "string" || /[\r\n]/u.test(note)))
    throw new Error("Operation notes are invalid.");
  return value;
}

function parseFindings(value: unknown): NonNullable<OperationPlan["findings"]> {
  if (!Array.isArray(value)) throw new Error("Operation findings must be an array.");
  return value.map((item) => {
    const finding = assertRecord(item, "Operation finding");
    assertKeys(finding, ["severity", "code", "message", "fix"], "Operation finding");
    if (finding.severity !== "error" && finding.severity !== "warning")
      throw new Error("Operation finding severity is invalid.");
    return {
      severity: finding.severity,
      code: readFindingText(finding.code, "Finding code", 80),
      message: readFindingText(finding.message, "Finding message"),
      fix: readFindingText(finding.fix, "Finding fix"),
    };
  });
}

function readFindingText(value: unknown, label: string, max = 1024): string {
  const text = readText(value, label);
  if (text.length > max || /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function parseVisibleIn(value: unknown): readonly ("omni" | "claude-code" | "codex")[] {
  if (!Array.isArray(value) || value.some((item) => item !== "omni" && item !== "claude-code" && item !== "codex"))
    throw new Error("Operation visibility is invalid.");
  if (new Set(value).size !== value.length) throw new Error("Operation visibility must be unique.");
  return value;
}

export function parseEmptyOperationsRequest(value: unknown): void {
  const request = assertRecord(value, "Operations request");
  assertKeys(request, [], "Operations request");
}

export function parsePreviewMarketplaceRequest(value: unknown): PreviewMarketplaceRequest {
  const request = assertRecord(value, "Marketplace preview request");
  assertKeys(request, ["kind", "parentToken", "name"], "Marketplace preview request");
  if (request.kind !== "create-marketplace") throw new Error("Operation kind is invalid.");
  return {
    kind: request.kind,
    parentToken: readOpaque(request.parentToken, "Parent token"),
    name: readText(request.name, "Marketplace name"),
  };
}

export function parsePreviewOperationRequest(
  value: unknown,
):
  | RegisterProjectRequest
  | PublishPluginRequest
  | CreateStorefrontRequest
  | RetryPushRequest
  | PreviewMarketplaceRequest
  | PreviewApplyPlanRequest
  | DescribePluginRequest
  | ImportOperationRequest
  | PreviewCompatibleRequest
  | WriteSkillRequest
  | RegisterMcpRequest
  | InstallAgentsRequest
  | DisconnectAgentsRequest
  | WriteHarnessSettingRequest
  | AddToProjectRequest {
  const request = assertRecord(value, "Operation preview request");
  if (request.kind === "register-project") return registerProjectSchema.parse(request);
  if (request.kind === "publish-plugin") return parsePublishPluginRequest(request);
  if (request.kind === "create-storefront") return parseCreateStorefrontRequest(request);
  if (request.kind === "retry-push") return parseRetryPushRequest(request);
  if (request.kind === "describe-plugin") return parseDescribePluginRequest(request);
  if (request.kind === "create-marketplace") return parsePreviewMarketplaceRequest(request);
  if (request.kind === "apply-plan") return parsePreviewApplyPlanRequest(request);
  if (request.kind === "make-compatible") return parsePreviewCompatibleRequest(request);
  if (request.kind === "write-skill") return parseWriteSkillRequest(request);
  if (request.kind === "register-mcp") return parseRegisterMcpRequest(request);
  if (request.kind === "disconnect-agents") return parseDisconnectAgentsRequest(request);
  if (request.kind === "install-agents") return parseInstallAgentsRequest(request);
  if (request.kind === "write-harness-setting") return parseWriteHarnessSettingRequest(request);
  if (request.kind === "add-to-project") return parseAddToProjectRequest(request);
  return parseImportOperationRequest(request);
}

function parsePreviewApplyPlanRequest(value: unknown): PreviewApplyPlanRequest {
  const request = assertRecord(value, "Apply plan preview request");
  assertKeys(request, ["kind", "projectId", "bindingIds"], "Apply plan preview request");
  if (request.kind !== "apply-plan") throw new Error("Operation kind is invalid.");
  if (!Array.isArray(request.bindingIds) || request.bindingIds.length === 0)
    throw new Error("Selected binding ids must be a non-empty array.");
  const bindingIds = request.bindingIds.map((value) => readOpaque(value, "Binding id"));
  if (new Set(bindingIds).size !== bindingIds.length) throw new Error("Selected binding ids must be unique.");
  return { kind: "apply-plan", projectId: readOpaque(request.projectId, "Project id"), bindingIds };
}

export function parseApplyOperationRequest(value: unknown): ApplyOperationRequest {
  const request = assertRecord(value, "Operation apply request");
  assertKeys(request, ["planId", "provenance", "conflictChoices"], "Operation apply request");
  const provenance = request.provenance === undefined ? undefined : parseApplyProvenance(request.provenance);
  return {
    planId: readOpaque(request.planId, "Plan id"),
    ...(provenance ? { provenance } : {}),
    ...(request.conflictChoices === undefined
      ? {}
      : { conflictChoices: conflictChoicesSchema.parse(request.conflictChoices) }),
  };
}

function parseApplyProvenance(value: unknown): NonNullable<ApplyOperationRequest["provenance"]> {
  const provenance = assertRecord(value, "Operation apply provenance");
  assertKeys(provenance, ["approval", "agent"], "Operation apply provenance");
  if (provenance.approval !== "conversation" && provenance.approval !== "omni")
    throw new Error("Operation approval is invalid.");
  const agent = provenance.agent === undefined ? undefined : assertRecord(provenance.agent, "Agent provenance");
  if (agent) {
    assertKeys(agent, ["harness", "sessionName", "requestedAt"], "Agent provenance");
    if (agent.harness !== "claude-code" && agent.harness !== "codex") throw new Error("Agent provenance is invalid.");
  }
  return {
    approval: provenance.approval,
    ...(agent
      ? {
          agent: {
            harness: agent.harness as "claude-code" | "codex",
            ...(agent.sessionName === undefined ? {} : { sessionName: readText(agent.sessionName, "Session name") }),
            requestedAt: readText(agent.requestedAt, "Requested at"),
          },
        }
      : {}),
  };
}

export function parsePickParentResponse(value: unknown): PickParentResponse {
  const response = assertRecord(value, "Parent picker response");
  if (response.status === "cancelled") {
    assertKeys(response, ["status"], "Parent picker response");
    return { status: "cancelled" };
  }
  assertKeys(response, ["status", "parentToken", "displayParent"], "Parent picker response");
  if (response.status !== "picked") throw new Error("Parent picker status is invalid.");
  return {
    status: "picked",
    parentToken: readOpaque(response.parentToken, "Parent token"),
    displayParent: readDisplay(response.displayParent, "Parent display"),
  };
}

export function parsePreviewMarketplaceResponse(value: unknown): PreviewMarketplaceResponse {
  const response = assertRecord(value, "Marketplace preview response");
  if (response.status === "blocked") {
    assertKeys(response, ["status", "reason", "diagnostic", "plan"], "Marketplace preview response");
    const plan = response.plan === undefined ? undefined : parsePlan(response.plan);
    return {
      status: "blocked",
      reason: readText(response.reason, "Block reason"),
      diagnostic: readDisplay(response.diagnostic, "Block diagnostic"),
      ...(plan ? { plan } : {}),
    };
  }
  assertKeys(response, ["status", "plan"], "Marketplace preview response");
  if (response.status !== "ready") throw new Error("Marketplace preview status is invalid.");
  return { status: "ready", plan: parsePlan(response.plan) };
}

export function parseApplyOperationResponse(value: unknown): ApplyOperationResponse {
  const response = assertRecord(value, "Operation apply response");
  assertKeys(response, ["status", "receipt"], "Operation apply response");
  if (response.status !== "applied" && response.status !== "failed")
    throw new Error("Operation apply status is invalid.");
  return { status: response.status, receipt: parseOperationReceipt(response.receipt) };
}
