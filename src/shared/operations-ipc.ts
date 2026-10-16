import type { RegisterProjectRequest, ProjectRegistrationPlan } from "./project-registration-ipc";
import type {
  PublishPluginRequest,
  CreateStorefrontRequest,
  RetryPushRequest,
  ConflictChoices,
  PublicationPlanSummary,
  PublicationReceipt,
} from "./publication-operations-ipc";
import type { DescribePluginRequest } from "./plugin-description-ipc";
import type { DisconnectAgentsRequest } from "./agent-maintenance-ipc";
export const OPERATIONS_IPC_CHANNELS = {
  pickParent: "omni:operations:pick-parent",
  preview: "omni:operations:preview",
  apply: "omni:operations:apply",
  list: "omni:operations:list",
  paths: "omni:operations:paths",
  receiptDiff: "omni:operations:receipt-diff",
} as const;

import type { EntryKind } from "../domain/project-source-registry";
import type { Binding } from "../domain/assignment-plan";
import type { ProjectPlan } from "../domain/assignment-plan";
import type { SkillFinding } from "../domain/skill-checks";
import type { ApprovalMode } from "./settings-ipc";
import { parseImportOperationRequest, type ImportOperationRequest } from "./operations-import-ipc";
import { parseWriteSkillRequest, type WriteSkillRequest } from "./operations-write-skill-ipc";
import { parseRegisterMcpRequest, type RegisterMcpRequest } from "./operations-register-mcp-ipc";
import { parseInstallAgentsRequest, type InstallAgentsRequest } from "./operations-install-agents-ipc";
import { parseWriteHarnessSettingRequest, type WriteHarnessSettingRequest } from "./operations-harness-setting-ipc";
import { parseBinding } from "./bindings-ipc";
import { parseAddToProjectRequest, type AddToProjectRequest } from "./operations-add-to-project-ipc";
import {
  parseCompatibilityReport,
  parsePreviewCompatibleRequest,
  type PreviewCompatibleRequest,
} from "./operations-compatible-ipc";

export { parsePathsResponse, parsePreviewImportRequest, parsePreviewRestoreRequest } from "./operations-import-ipc";
export type { ImportArtifactRequest, PathsResponse, RestoreImportRequest } from "./operations-import-ipc";
export { parseWriteSkillRequest } from "./operations-write-skill-ipc";
export type { SkillAgentProvenance, WriteSkillFile, WriteSkillRequest } from "./operations-write-skill-ipc";
export { parseRegisterMcpRequest } from "./operations-register-mcp-ipc";
export type { RegisterMcpAction, RegisterMcpHarness, RegisterMcpRequest } from "./operations-register-mcp-ipc";
export { parseInstallAgentsRequest } from "./operations-install-agents-ipc";
export type { InstallAgentsRequest } from "./operations-install-agents-ipc";
export { parseWriteHarnessSettingRequest } from "./operations-harness-setting-ipc";
export type { WriteHarnessSettingRequest } from "./operations-harness-setting-ipc";
export { parseCompatibilityReport, parsePreviewCompatibleRequest } from "./operations-compatible-ipc";
export type { CompatibilityReport, PreviewCompatibleRequest } from "./operations-compatible-ipc";
export { parseAddToProjectRequest } from "./operations-add-to-project-ipc";
export type { AddToProjectRequest } from "./operations-add-to-project-ipc";

// One list of operation kinds: the type and both parsers derive from it.
export const OPERATION_KINDS = [
  "register-project",
  "archive-project",
  "install-external-skill",
  "update-external-skills",
  "merge-external-skill",
  "publish-plugin",
  "create-storefront",
  "retry-push",
  "skill-management",
  "create-marketplace",
  "import-artifact",
  "describe-plugin",
  "make-compatible",
  "write-skill",
  "register-mcp",
  "install-agents",
  "disconnect-agents",
  "restore-import",
  "apply-plan",
  "remove-binding",
  "adopt-skill",
  "resolve-skill",
  "capture-skill",
  "link-skill",
  "restore-apply",
  "restore-add-to-project",
  "stop-process",
  "remove-worktree",
  "signal-process",
  "renice-process",
  "write-harness-setting",
  "add-to-project",
  "detach-skill",
  "propagate-skill",
  "bridge-skill-uses",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];
export type OperationActionKind = "create-directory" | "write-file" | "delete-file" | "delete-directory";
export type OperationActionStatus = "applied" | "failed" | "rolled-back";
export type GitMode =
  "init-and-commit" | "commit" | "enclosing-repository" | "unavailable" | "not-a-repository" | "disabled";

export type OperationAction = Readonly<{
  kind: OperationActionKind;
  relativePath: string;
  byteLength?: number;
  beforeHash?: string;
  afterHash?: string;
  manifest?: boolean;
  diff?: string;
}>;

export type OperationPlan = Readonly<{
  planId: string;
  kind: OperationKind;
  displayTarget: string;
  packageId?: string;
  actions: readonly OperationAction[];
  git: Readonly<{ mode: GitMode; warnings: readonly string[] }>;
  visibleIn?: readonly ("omni" | "claude-code" | "codex")[];
  report?: import("./operations-compatible-ipc").CompatibilityReport;
  findings?: readonly SkillFinding[];
  notes?: readonly string[];
  projectRegistration?: ProjectRegistrationPlan;
  harnesses?: readonly Readonly<{
    harness: "claude-code" | "codex";
    status: "changes" | "nothing-to-do";
    mcp: "add" | "keep";
    skills: Readonly<{ add: readonly string[]; update: readonly string[]; keep: readonly string[] }>;
    guard: "add" | "keep" | "update";
  }>[];
  steps?: readonly OperationStep[];
  publication?: PublicationPlanSummary;
}>;

export type OperationStep =
  Readonly<{ kind: "import"; plan: OperationPlan }> | Readonly<{ kind: "assign"; plan: ProjectPlan }>;

export type OperationActionReceipt = OperationAction & Readonly<{ status: OperationActionStatus }>;

export type OperationReceipt = Readonly<{
  operationId: string;
  kind: OperationKind;
  status: "applied" | "failed";
  appliedAt: string;
  displayTarget: string;
  packageId?: string;
  actions: readonly OperationActionReceipt[];
  git: Readonly<{ mode: GitMode; commit?: string; headBefore?: string; headAfter?: string }>;
  registered: Readonly<{ sourceId: string }> | null;
  source?: Readonly<{ kind: EntryKind; id: string; relativePath: string }>;
  project?: Readonly<{ id: string }>;
  bindings?: readonly Readonly<{
    bindingId: string;
    previousOwnedHash?: string;
    binding?: Binding;
    before?: Binding;
    after?: Binding;
  }>[];
  units?: readonly string[];
  restores?: string;
  files?: readonly Readonly<{ relativePath: string; contentHash: string; previousHash?: string }>[];
  manifests?: readonly Readonly<{ relativePath: string; beforeHash?: string; afterHash: string }>[];
  provenance?: Readonly<{
    copiedFrom?: import("./skill-copy-provenance").SkillCopyProvenance;
    agent?: Readonly<{ harness: "claude-code" | "codex"; sessionName?: string; requestedAt: string }>;
    approval?: ApprovalMode | "automatic";
    reason?: string;
  }>;
  skillMode?: "create" | "update";
  mcpAction?: "enable" | "disable";
  cliPath?: string;
  agentSetup?: Readonly<{
    action: "connect" | "reinstall" | "update" | "disconnect";
    harnesses: readonly ("claude-code" | "codex")[];
    version?: string;
  }>;
  restored?: boolean;
  diagnostic?: string;
  createdDirectories?: readonly string[];
  // Target harness of a make-compatible operation.
  harness?: "claude-code" | "codex";
  // Present only on `signal-process` receipts: which signal was sent, for the Review label
  // ("Paused agent x" / "Resumed agent x" / "Killed agent x").
  signalAction?: "kill" | "pause" | "resume";
  // Present only on `renice-process` receipts: the priority level that was set.
  nice?: 10 | 0;
  // Present only on `write-harness-setting` receipts (D6): the key/value written and the value
  // it replaced, so Review can render "Claude Code worktree cleanup: 14 days" without re-parsing
  // the settings file, and restore can compute the reverse edit.
  harnessSetting?: Readonly<{
    harness: "claude-code";
    key: string;
    value: number | null;
    previousValue: number | null;
  }>;
  skillManagement?: Omit<import("./skill-management-ipc").SkillResult, "receipts">;
  adoption?: Readonly<{ intentId: string; stepId: string }>;
  reconciliation?: Readonly<{ intentId: string; stepId: string }>;
  capture?: Readonly<{ intentId: string; stepId: string }>;
  link?: Readonly<{ intentId: string; stepId: string }>;
  detachment?: Readonly<{ intentId: string; stepId: string }>;
  skillPropagation?: import("./skill-propagation-ipc").SkillPropagationReceiptPointer;
  externalSkill?: import("./external-skill-effects").ExternalSkillEvidence;
  legacyBridge?: import("./legacy-binding-bridge-receipt").LegacyBindingBridgeReceipt;
  children?: readonly string[];
  failedStep?: "import" | "assign";
  publication?: PublicationReceipt;
}>;

export type PickParentResponse =
  Readonly<{ status: "picked"; parentToken: string; displayParent: string }> | Readonly<{ status: "cancelled" }>;
export type PreviewMarketplaceRequest = Readonly<{ kind: "create-marketplace"; parentToken: string; name: string }>;
export type PreviewApplyPlanRequest = Readonly<{
  kind: "apply-plan";
  projectId: string;
  bindingIds: readonly string[];
}>;
export type PreviewMarketplaceResponse =
  | Readonly<{ status: "ready"; plan: OperationPlan }>
  | Readonly<{ status: "blocked"; reason: string; diagnostic: string; plan?: OperationPlan }>;
export type OperationApplyProvenance = Readonly<{
  approval: ApprovalMode;
  agent?: Readonly<{ harness: "claude-code" | "codex"; sessionName?: string; requestedAt: string }>;
}>;
export type ApplyOperationRequest = Readonly<{
  planId: string;
  provenance?: OperationApplyProvenance;
  conflictChoices?: ConflictChoices;
}>;
export type ApplyOperationResponse = Readonly<{ status: "applied" | "failed"; receipt: OperationReceipt }>;
export type ListOperationsResponse = Readonly<{ status: "ready"; receipts: readonly OperationReceipt[] }>;
export type ReceiptDiffRequest = Readonly<{ operationId: string; relativePath: string }>;
export type ReceiptDiffResponse =
  | Readonly<{
      status: "ready";
      diff: Readonly<{ kind: "unified"; text: string; truncated: boolean }>;
      before: Readonly<{ byteLength: number }>;
      after?: Readonly<{ byteLength: number; changedSince: boolean }>;
    }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export {
  parseEmptyOperationsRequest,
  parsePreviewMarketplaceRequest,
  parsePreviewOperationRequest,
  parseApplyOperationRequest,
  parsePickParentResponse,
  parsePreviewMarketplaceResponse,
  parseApplyOperationResponse,
} from "./operations-ipc-parsers";
export { parseReceiptDiffRequest, parseReceiptDiffResponse } from "./operations-receipt-parsers";

export interface OperationsDesktopApi {
  pickOperationParent(): Promise<PickParentResponse>;
  previewOperation(
    request:
      | PublishPluginRequest
      | CreateStorefrontRequest
      | RetryPushRequest
      | PreviewMarketplaceRequest
      | PreviewApplyPlanRequest
      | RegisterProjectRequest
      | DescribePluginRequest
      | ImportOperationRequest
      | PreviewCompatibleRequest
      | WriteSkillRequest
      | RegisterMcpRequest
      | InstallAgentsRequest
      | DisconnectAgentsRequest
      | WriteHarnessSettingRequest
      | AddToProjectRequest,
  ): Promise<PreviewMarketplaceResponse>;
  applyOperation(request: ApplyOperationRequest): Promise<ApplyOperationResponse>;
  listOperations(): Promise<ListOperationsResponse>;
  getReceiptDiff(request: ReceiptDiffRequest): Promise<ReceiptDiffResponse>;
  getOperationPaths(): Promise<import("./operations-import-ipc").PathsResponse>;
}
