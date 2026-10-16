import type { Binding } from "../domain/assignment-plan";
import type { HarnessId } from "../domain/harness-targets";
import type { ApprovalMode } from "./settings-ipc";
import { type OperationPlan, type OperationReceipt } from "./operations-ipc";
import { parseOperationReceipt } from "./operations-receipt-parsers";
import type { WriteSkillRequest } from "./operations-write-skill-ipc";
import type { SkillReconciliationRequest } from "./skill-reconciliation-request";
import type { SourceSkillRef } from "../domain/skill-reconciliation/types";
import type { SkillPropagationIntent, SkillPropagationSummary } from "./skill-propagation-ipc";
import { parseSkillPropagationSummary } from "./skill-propagation-ipc";
import type {
  SkillDetachmentDetails,
  SkillDetachmentEvidence,
  SkillDetachmentRestoreOrigin,
} from "./skill-detachment-effects";
import {
  parseSkillVariantCaptureDetails,
  type SkillVariantCaptureDetails,
  type SkillVariantCaptureEvidence,
  type ReadSkillVariantOriginResponse,
} from "./skill-variant-effects";
import { parseSkillIntent } from "./skill-intent-parser";
import { parseEffectStep, parseScope } from "./skill-management-effect-parser";
import {
  parseSkillUnboundResolutionDetails,
  type SkillUnboundResolutionDetails,
  type SkillUnboundResolutionEvidence,
  type SkillUnboundResolutionEnvelope,
  type SkillUnboundResolutionRestoreOrigin,
} from "./skill-unbound-resolution-effects";
export { parseSkillIntent };
import {
  parseSkillAdoptionResolution,
  type SkillAdoptionBaseReference,
  type SkillAdoptionEvidence,
  type SkillAdoptionResolution,
} from "./skill-adoption-effects";
import {
  parseSkillManagedResolutionDetails,
  type SkillManagedResolutionDetails,
  type SkillResolutionEvidence,
} from "./skill-resolution-effects";
import { parseSkillDetachmentDetails } from "./skill-detachment-effects";
import type { SkillPropagationStepEvidence } from "./skill-propagation-effects";
export {
  parseSkillActor,
  parseSkillManagementApplyRequest,
  parseSkillManagementPreviewRequest,
  parseSkillManagementRefreshRequest,
  parseSkillManagementResultRequest,
} from "./skill-management-request-parsers";

export const SKILL_MANAGEMENT_IPC_CHANNELS = {
  preview: "omni:skill-management:preview",
  refresh: "omni:skill-management:refresh",
  apply: "omni:skill-management:apply",
  result: "omni:skill-management:result",
  recoveries: "omni:skill-management:recoveries",
  variantOrigin: "omni:skill-management:variant-origin",
  propagationCandidates: "omni:skill-management:propagation-candidates",
  projectSkills: "omni:skill-management:project-skills",
} as const;

export type SkillIntent =
  | import("./external-skill-intents").ExternalSkillIntent
  | import("./project-skills-ipc").ProjectSkillIntent
  | Readonly<{ kind: "write"; request: WriteSkillRequest }>
  | Readonly<{
      kind: "assign";
      sourceId: string;
      packageId: string;
      artifactPath?: string;
      targets: readonly Readonly<{ projectId: string; harnessIds: readonly HarnessId[] }>[];
    }>
  | Readonly<{ kind: "remove"; bindingIds: readonly string[] }>
  | Readonly<{ kind: "reconcile"; request: SkillReconciliationRequest }>
  | SkillPropagationIntent
  | Readonly<{ kind: "restore"; operationId: string }>;

export type SkillActor =
  | Readonly<{ kind: "desktop"; automatic?: true }>
  | Readonly<{ kind: "mcp"; requestId?: string; harness?: "claude-code" | "codex"; sessionName?: string }>;

export type SkillAuthorization =
  | Readonly<{ kind: "desktop"; effectFingerprint: string; approvedAt: string }>
  | Readonly<{
      kind: "agent";
      requestId: string;
      leaseId: string;
      approvedAt: string;
      effectFingerprint: string;
      approval?: ApprovalMode;
    }>;

export type SkillScope = Readonly<{
  sourceId?: string;
  packageId?: string;
  artifactPath?: string;
  targets: readonly Readonly<{ projectId: string; harnessId: HarnessId; bindingId?: string }>[];
}>;

export type SkillFileSummary = Readonly<{
  rootId: string;
  relativePath: string;
  change: "add" | "change" | "delete" | "unchanged";
  byteLength?: number;
  diff?: string;
  summary?: string;
  beforeHash?: string;
  afterHash?: string;
}>;

export type SkillBindingEffect = Readonly<{
  bindingId: string;
  before?: Binding;
  after?: Binding;
}>;

export type SkillEffectStep = Readonly<{
  stepId: string;
  scope: SkillScope;
  plan: OperationPlan;
  bindingEffects: readonly SkillBindingEffect[];
  files: readonly SkillFileSummary[];
  metadataEffects?: readonly import("../domain/skill-reconciliation/types").SkillUseEffect[];
  baseReferences?: readonly SkillAdoptionBaseReference[];
  adoptionEvidence?: SkillAdoptionEvidence;
  resolutionEvidence?: SkillResolutionEvidence;
  variantCaptureEvidence?: SkillVariantCaptureEvidence;
  unboundResolutionEvidence?: SkillUnboundResolutionEvidence;
  unboundResolutionEnvelope?: SkillUnboundResolutionEnvelope;
  unboundResolutionRestoreOrigin?: SkillUnboundResolutionRestoreOrigin;
  detachmentEvidence?: SkillDetachmentEvidence;
  detachmentRestoreOrigin?: SkillDetachmentRestoreOrigin;
  propagationEvidence?: SkillPropagationStepEvidence;
  projectSkillEvidence?: import("./project-skill-effects").ProjectSkillEvidence;
  externalSkillEvidence?: import("./external-skill-effects").ExternalSkillEvidence;
}>;

export type SkillIssue = Readonly<{
  code: string;
  message: string;
  stepId?: string;
  relativePath?: string;
  projectId?: string;
  recoveryAction: "refresh" | "choose-targets" | "open-changes" | "reconnect" | "inspect-recovery";
}>;

export type SkillPreview =
  | Readonly<{
      status: "ready";
      intentId: string;
      planId: string;
      effectFingerprint: string;
      scope: SkillScope;
      steps: readonly SkillEffectStep[];
      propagation?: SkillPropagationSummary;
    }>
  | Readonly<{
      status: "blocked" | "needs-input" | "stale";
      intentId: string;
      reason: string;
      details: readonly SkillIssue[];
    }>;

export type SkillTargetOutcome = Readonly<{
  projectId: string;
  harnessId: HarnessId;
  bindingId: string;
  artifactPath: string;
  status:
    | "applied"
    | "removed"
    | "no-op"
    | "retained-local"
    | "skipped"
    | "failed"
    | "cancelled"
    | "restored"
    | "unknown"
    | "pending";
  issue?: SkillIssue;
}>;

export type SkillResult = Readonly<{
  intentId: string;
  operationId: string;
  status: "applied" | "no-op" | "partial" | "failed" | "cancelled" | "recovery-required" | "restored" | "applying";
  source: Readonly<{
    status: "unchanged" | "created" | "updated" | "failed" | "restored" | "unknown";
    sourceId?: string;
  }>;
  targets: readonly SkillTargetOutcome[];
  receiptIds: readonly string[];
  receipts?: readonly OperationReceipt[];
  issues: readonly SkillIssue[];
  recoveryAvailable: boolean;
  resolution?: SkillAdoptionResolution | SkillManagedResolutionDetails;
  capture?: SkillVariantCaptureDetails;
  link?: SkillUnboundResolutionDetails;
  detachment?: SkillDetachmentDetails;
  propagation?: SkillPropagationSummary;
}>;

export type SkillManagementPreviewRequest = Readonly<{ intent: SkillIntent; requestId?: string }>;
export type SkillManagementRefreshRequest = Readonly<{ intentId: string; requestId?: string }>;
export type SkillManagementApplyRequest = Readonly<{ intentId: string; effectFingerprint: string; requestId?: string }>;
export type SkillManagementResultRequest = Readonly<{ intentId: string }>;

export interface SkillManagementDesktopApi {
  readProjectSkills(projectId: string): Promise<import("./project-skills-ipc").ProjectSkills>;
  listSkillOperationRecoveries(): Promise<readonly SkillResult[]>;
  previewSkillOperation(request: SkillManagementPreviewRequest): Promise<SkillPreview>;
  refreshSkillOperation(request: SkillManagementRefreshRequest): Promise<SkillPreview>;
  applySkillOperation(request: SkillManagementApplyRequest): Promise<SkillResult>;
  readSkillOperationResult(request: SkillManagementResultRequest): Promise<SkillResult | undefined>;
  readSkillVariantOrigin(source: SourceSkillRef): Promise<ReadSkillVariantOriginResponse>;
  readSkillPropagationCandidates(
    source: SourceSkillRef,
  ): Promise<readonly import("./skill-propagation-ipc").SkillPropagationCandidate[]>;
}

type RecordValue = Record<string, unknown>;
const HARNESSES: readonly HarnessId[] = ["claude-code", "codex", "cursor"];

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
    /[\\/\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value.trim();
}
function readableText(value: unknown, label: string, max = 4096): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value;
}
function relativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`${label} is invalid.`);
  const path = value.trim().replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${label} must be a safe relative path.`);
  return path;
}
function harness(value: unknown): HarnessId {
  if (!HARNESSES.includes(value as HarnessId)) throw new Error("Harness id is invalid.");
  return value as HarnessId;
}
function unique(values: readonly string[], label: string): void {
  if (!values.length || new Set(values).size !== values.length)
    throw new Error(`${label} must be non-empty and unique.`);
}

export function parseSkillIssue(value: unknown): SkillIssue {
  const issue = record(value, "Skill issue");
  keys(issue, ["code", "message", "stepId", "relativePath", "projectId", "recoveryAction"], "Skill issue");
  const actions = ["refresh", "choose-targets", "open-changes", "reconnect", "inspect-recovery"];
  if (!actions.includes(String(issue.recoveryAction))) throw new Error("Skill recovery action is invalid.");
  return {
    code: id(issue.code, "Skill issue code"),
    message: readableText(issue.message, "Skill issue message"),
    ...(issue.stepId === undefined ? {} : { stepId: id(issue.stepId, "Skill step id") }),
    ...(issue.relativePath === undefined ? {} : { relativePath: relativePath(issue.relativePath, "Skill issue path") }),
    ...(issue.projectId === undefined ? {} : { projectId: id(issue.projectId, "Skill issue project id") }),
    recoveryAction: issue.recoveryAction as SkillIssue["recoveryAction"],
  };
}

export function parseSkillEffectDescriptor(value: unknown): Readonly<{
  planId: string;
  scope: SkillScope;
  steps: readonly SkillEffectStep[];
  propagation?: SkillPropagationSummary;
}> {
  const descriptor = record(value, "Skill effect descriptor");
  keys(descriptor, ["planId", "scope", "steps", "propagation"], "Skill effect descriptor");
  if (!Array.isArray(descriptor.steps)) throw new Error("Skill effect steps are invalid.");
  const steps = descriptor.steps.map(parseEffectStep);
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length)
    throw new Error("Skill effect steps are duplicated.");
  return {
    planId: id(descriptor.planId, "Skill plan id"),
    scope: parseScope(descriptor.scope),
    steps,
    ...(descriptor.propagation === undefined
      ? {}
      : { propagation: parseSkillPropagationSummary(descriptor.propagation) }),
  };
}

export function parseSkillPreview(value: unknown): SkillPreview {
  const preview = record(value, "Skill preview");
  if (preview.status === "ready") {
    keys(
      preview,
      ["status", "intentId", "planId", "effectFingerprint", "scope", "steps", "propagation"],
      "Ready skill preview",
    );
    if (!Array.isArray(preview.steps)) throw new Error("Skill preview steps are invalid.");
    const fingerprint = preview.effectFingerprint;
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint))
      throw new Error("Skill effect fingerprint is invalid.");
    const steps = preview.steps.map(parseEffectStep);
    if (new Set(steps.map((step) => step.stepId)).size !== steps.length)
      throw new Error("Skill preview steps are duplicated.");
    return {
      status: "ready",
      intentId: id(preview.intentId, "Intent id"),
      planId: id(preview.planId, "Plan id"),
      effectFingerprint: fingerprint,
      scope: parseScope(preview.scope),
      steps,
      ...(preview.propagation === undefined ? {} : { propagation: parseSkillPropagationSummary(preview.propagation) }),
    };
  }
  keys(preview, ["status", "intentId", "reason", "details"], "Blocked skill preview");
  if (!["blocked", "needs-input", "stale"].includes(String(preview.status)) || !Array.isArray(preview.details))
    throw new Error("Skill preview is invalid.");
  return {
    status: preview.status as "blocked" | "needs-input" | "stale",
    intentId: id(preview.intentId, "Intent id"),
    reason: readableText(preview.reason, "Skill preview reason"),
    details: preview.details.map(parseSkillIssue),
  };
}

export function parseSkillResult(value: unknown): SkillResult {
  const result = record(value, "Skill result");
  keys(
    result,
    [
      "intentId",
      "operationId",
      "status",
      "source",
      "targets",
      "receiptIds",
      "receipts",
      "issues",
      "recoveryAvailable",
      "resolution",
      "capture",
      "link",
      "detachment",
      "propagation",
    ],
    "Skill result",
  );
  const statuses = ["applied", "no-op", "partial", "failed", "cancelled", "recovery-required", "restored", "applying"];
  if (!statuses.includes(String(result.status)) || typeof result.recoveryAvailable !== "boolean")
    throw new Error("Skill result status is invalid.");
  const source = record(result.source, "Skill result source");
  keys(source, ["status", "sourceId"], "Skill result source");
  if (!["unchanged", "created", "updated", "failed", "restored", "unknown"].includes(String(source.status)))
    throw new Error("Skill source result is invalid.");
  if (
    !Array.isArray(result.targets) ||
    !Array.isArray(result.receiptIds) ||
    !Array.isArray(result.issues) ||
    (result.receipts !== undefined && !Array.isArray(result.receipts))
  )
    throw new Error("Skill result collections are invalid.");
  const targets = result.targets.map((value) => {
    const target = record(value, "Skill target result");
    keys(target, ["projectId", "harnessId", "bindingId", "artifactPath", "status", "issue"], "Skill target result");
    const targetStatuses = [
      "applied",
      "removed",
      "no-op",
      "retained-local",
      "skipped",
      "failed",
      "cancelled",
      "restored",
      "unknown",
      "pending",
    ];
    if (!targetStatuses.includes(String(target.status))) throw new Error("Skill target result status is invalid.");
    return {
      projectId: id(target.projectId, "Project id"),
      harnessId: harness(target.harnessId),
      bindingId: id(target.bindingId, "Binding id"),
      artifactPath: relativePath(target.artifactPath, "Artifact path"),
      status: target.status as SkillTargetOutcome["status"],
      ...(target.issue === undefined ? {} : { issue: parseSkillIssue(target.issue) }),
    };
  });
  const targetKeys = targets.map((target) => `${target.projectId}\n${target.harnessId}\n${target.bindingId}`);
  if (new Set(targetKeys).size !== targetKeys.length) throw new Error("Skill target results are duplicated.");
  const receiptIds = result.receiptIds.map((value) => id(value, "Receipt id"));
  if (new Set(receiptIds).size !== receiptIds.length) throw new Error("Skill receipt ids are duplicated.");
  const resolution =
    result.resolution === undefined
      ? undefined
      : (() => {
          const candidate = record(result.resolution, "Skill resolution result");
          return candidate.choice === "adopt-exact"
            ? parseSkillAdoptionResolution(candidate)
            : parseSkillManagedResolutionDetails(candidate);
        })();
  const capture = result.capture === undefined ? undefined : parseSkillVariantCaptureDetails(result.capture);
  const link = result.link === undefined ? undefined : parseSkillUnboundResolutionDetails(result.link);
  const detachment = result.detachment === undefined ? undefined : parseSkillDetachmentDetails(result.detachment);
  const canonicalAdoptionLink = Boolean(
    resolution &&
    resolution.choice === "adopt-exact" &&
    link &&
    resolution.skillId === link.skillId &&
    resolution.targets.length === 1 &&
    resolution.targets[0]?.bindingId === link.bindingId &&
    JSON.stringify([
      resolution.targets[0]?.location.projectId,
      resolution.targets[0]?.location.harnessId,
      resolution.targets[0]?.location.folderPath,
    ]) === JSON.stringify([link.location.projectId, link.location.harnessId, link.location.folderPath]) &&
    ((resolution.targets[0]?.status === "applied" && link.status === "applied") ||
      (resolution.targets[0]?.status === "restored" && link.status === "restored")),
  );
  if (
    ([resolution, capture, link, detachment].filter(Boolean).length > 1 && !canonicalAdoptionLink) ||
    (canonicalAdoptionLink && (capture || detachment)) ||
    (result.propagation !== undefined && [resolution, capture, link, detachment].some(Boolean))
  )
    throw new Error("A skill result cannot mix reconciliation effects.");
  if (capture && targets.length !== 0) throw new Error("Personal variant capture cannot report project targets.");
  return {
    intentId: id(result.intentId, "Intent id"),
    operationId: id(result.operationId, "Operation id"),
    status: result.status as SkillResult["status"],
    source: {
      status: source.status as SkillResult["source"]["status"],
      ...(source.sourceId === undefined ? {} : { sourceId: id(source.sourceId, "Source id") }),
    },
    targets,
    receiptIds,
    ...(result.receipts === undefined ? {} : { receipts: result.receipts.map(parseOperationReceipt) }),
    issues: result.issues.map(parseSkillIssue),
    recoveryAvailable: result.recoveryAvailable,
    ...(resolution === undefined ? {} : { resolution }),
    ...(capture === undefined ? {} : { capture }),
    ...(link === undefined ? {} : { link }),
    ...(detachment === undefined ? {} : { detachment }),
    ...(result.propagation === undefined ? {} : { propagation: parseSkillPropagationSummary(result.propagation) }),
  };
}
