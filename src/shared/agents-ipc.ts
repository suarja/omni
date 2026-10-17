import { linkStorefrontSchema, parseStorefrontLinkPlan, type LinkStorefrontRequest } from "./storefront-link-ipc";
import {
  registerProjectSchema,
  parseProjectRegistrationPlan,
  type RegisterProjectRequest,
} from "./project-registration-ipc";
import {
  parsePublishPluginRequest,
  parsePublicationPlanSummary,
  type PublishPluginRequest,
} from "./publication-operations-ipc";
import { parsePluginDescription } from "./plugin-description-ipc";
import { externalInstallSchema } from "./external-skill-intents";
import type {
  InventoryArtifactKind,
  ObservedArtifact,
  ObservedPackage,
  RemotePackageDeclaration,
} from "../domain/inventory";
import type { Binding, ProjectPlan } from "../domain/assignment-plan";
import type { EntryRef } from "../domain/project-source-registry";
import { OPERATION_KINDS, type OperationPlan } from "./operations-ipc";
import type { ApprovalMode } from "./settings-ipc";
import { parseSkillIntent, type SkillIntent } from "./skill-management-ipc";
import { parseWriteSkillRequest, type WriteSkillRequest } from "./operations-write-skill-ipc";
import { parseSkillPropagationIntent, type SkillPropagationIntent } from "./skill-propagation-ipc";
import { parseBinding } from "./bindings-ipc";
import {
  parseAgentDeclineRequest,
  parseAgentBeginApplyRequest,
  parseAgentEndApplyRequest,
  parseAgentApplyAuthorization,
  parseAgentReceiptRequest,
  parseAgentTerminalReferences,
  type AgentApplyOutcome,
  type AgentApplyAuthorization,
  type AgentBeginApplyRequest,
  type AgentEndApplyRequest,
  type AgentResolveRequest,
} from "./agent-outcome-ipc";
export {
  parseAgentDeclineRequest,
  parseAgentBeginApplyRequest,
  parseAgentEndApplyRequest,
  parseAgentApplyAuthorization,
  parseAgentReceiptRequest,
  parseAgentResolveRequest,
  parseAgentApplyOutcome,
} from "./agent-outcome-ipc";
export type {
  AgentApplyOutcome,
  AgentApplyAuthorization,
  AgentBeginApplyRequest,
  AgentEndApplyRequest,
  AgentReceiptRequest,
  AgentReceiptResponse,
  AgentResolveRequest,
} from "./agent-outcome-ipc";

export const AGENTS_IPC_CHANNELS = {
  openRequest: "omni:agents:open-request",
  list: "omni:agents:list",
  resolve: "omni:agents:resolve",
  decline: "omni:agents:decline",
  refresh: "omni:agents:refresh",
  beginApply: "omni:agents:begin-apply",
  endApply: "omni:agents:end-apply",
  status: "omni:agents:status",
  rotateToken: "omni:agents:rotate-token",
} as const;

export type AgentHarness = "claude-code" | "codex";
export type AgentWriteRequest =
  | LinkStorefrontRequest
  | RegisterProjectRequest
  | import("./external-skill-intents").ExternalInstallIntent
  | PublishPluginRequest
  | Readonly<{
      kind: "import-artifact";
      projectId: string;
      relativePath: string;
      target: AgentCaptureTarget;
    }>
  | Readonly<{ kind: "make-compatible"; sourceId: string; harness: AgentHarness; packageId?: string }>
  | WriteSkillRequest
  | Readonly<{
      kind: "assign";
      artifactPath: string;
      sourceId: string;
      packageId: string;
      projectIds: readonly string[];
      harnesses?: readonly AgentHarness[];
    }>
  | Readonly<{ kind: "remove-skill"; bindingIds: readonly string[] }>
  | Readonly<{ kind: "restore-skill"; operationId: string }>
  | SkillPropagationIntent;
type ExistingCaptureTarget = Readonly<{
  packageId: string;
  newPackageName?: never;
  description?: never;
  projectTo?: never;
}>;
type NewCaptureTarget = Readonly<{
  packageId?: never;
  newPackageName: string;
  description: string;
  projectTo?: readonly AgentHarness[];
}>;
export type AgentCaptureTarget = ExistingCaptureTarget | NewCaptureTarget;
type StoredCaptureTarget =
  ExistingCaptureTarget | (Omit<NewCaptureTarget, "description"> & Readonly<{ description?: string }>);
// rc.8/rc.9 captures predate mandatory plugin descriptions. Only history may omit one.
export type StoredAgentWriteRequest =
  | Exclude<AgentWriteRequest, { kind: "import-artifact" }>
  | (Omit<Extract<AgentWriteRequest, { kind: "import-artifact" }>, "target"> &
      Readonly<{ target: StoredCaptureTarget }>);
export type AgentPlan =
  OperationPlan | Readonly<{ kind: "assign"; plans: readonly ProjectPlan[]; bindings?: readonly Binding[] }>;
export type AgentRequestStatus = "pending" | "awaiting-agent" | "approved" | "declined" | "expired";
export type AgentConsent = Readonly<{
  mode: ApprovalMode;
  at: string;
  harness?: AgentHarness;
  sessionName?: string;
}>;
export type ApprovalReason =
  | Readonly<{ code: "deletes-files"; count: number }>
  | Readonly<{
      code:
        | "public-publication"
        | "asked-in-omni"
        | "registry-unavailable"
        | "not-owned-source"
        | "conflict"
        | "projects-setting"
        | "marketplace-setting";
    }>;

export function parseApprovalReason(value: unknown): ApprovalReason {
  const reason = record(value, "Approval reason");
  if (reason.code === "deletes-files") {
    keys(reason, ["code", "count"], "Approval reason");
    if (typeof reason.count !== "number" || !Number.isSafeInteger(reason.count) || reason.count < 1)
      throw new Error("Approval deletion count is invalid.");
    return { code: reason.code, count: reason.count };
  }
  keys(reason, ["code"], "Approval reason");
  if (
    ![
      "public-publication",
      "asked-in-omni",
      "registry-unavailable",
      "not-owned-source",
      "conflict",
      "projects-setting",
      "marketplace-setting",
    ].includes(String(reason.code))
  )
    throw new Error("Approval reason is invalid.");
  return { code: reason.code as Exclude<ApprovalReason["code"], "deletes-files"> };
}

export type AgentRequest = Readonly<{
  requestId: string;
  createdAt: string;
  expiresAt: string;
  harness?: AgentHarness;
  sessionName?: string;
  cwd?: string;
  request: StoredAgentWriteRequest;
  plan: AgentPlan;
  approval: ApprovalMode;
  approvalReason?: ApprovalReason;
  status: AgentRequestStatus;
  intentId?: string;
  skillIntent?: SkillIntent;
  receiptId?: string;
  receiptIds?: readonly string[];
  applyOutcome?: AgentApplyOutcome;
  consent?: AgentConsent;
}>;

export type AgentStatus = Readonly<{
  appVersion?: string;
  socketPath: string;
  tokenCreatedAt: string;
  counts: Readonly<{ pending: number; today: number; total: number }>;
  harnesses: readonly Readonly<{
    harness: AgentHarness;
    detected: boolean;
    registered: boolean;
    settingsPath: string;
    skillsPath: string;
    current: boolean;
    skills: readonly Readonly<{ name: string; state: "installed" | "outdated" | "missing" | "foreign" }>[];
    guard: boolean;
    lastSeenAt?: string;
  }>[];
}>;
export type AgentListResponse = Readonly<{ status: "ready"; requests: readonly AgentRequest[] }>;
export type AgentDeclineRequest = Readonly<{ requestId: string }>;

export type AgentMarketplacePackage = Readonly<{
  id: string;
  name: string;
  description?: string;
  version?: string;
  visibleIn: readonly string[];
  artifacts: readonly Readonly<{ kind: InventoryArtifactKind; path: string; summary?: string }>[];
}>;
export type AgentSourceSummary = Readonly<{
  id: string;
  name: string;
  role: "workshop" | "storefront";
  githubRepository?: string;
  drift:
    | Readonly<{ status: "ready"; toPublish: number; conflicts: number; unavailablePlugins: number }>
    | Readonly<{ status: "unavailable" }>
    | null;
}>;
export type AgentMarketplaceResponse = Readonly<{
  status: "ready";
  marketplace: Readonly<{ id: string; name: string }>;
  packages: readonly AgentMarketplacePackage[];
  remotePackages: readonly RemotePackageDeclaration[];
  workshop?: AgentSourceSummary | null;
  storefronts?: readonly AgentSourceSummary[];
}>;
export type AgentStatusResponse = Readonly<{
  status: "ready";
  appVersion: string;
  build?: Readonly<{
    version: string;
    commit: string;
    channel: "release" | "development";
    builtAt: string;
    platform: string;
    arch: string;
    protocolVersion: string;
    agentBundleHash: string;
  }>;
  profilePath?: string;
  appPath?: string;
  workshop?: AgentSourceSummary | null;
  storefronts?: readonly AgentSourceSummary[];
  personalMarketplace: Readonly<{ id: string; name: string }> | null;
  projects: readonly Readonly<{ id: string; name: string; root: string; available: boolean; reason?: string }>[];
}>;
export type AgentSkillMatch = Readonly<{
  root: EntryRef;
  packageId?: string;
  artifact: Pick<ObservedArtifact, "id" | "kind" | "relativePath" | "displayPath" | "summary">;
  package?: Pick<ObservedPackage, "id" | "displayName" | "description" | "version">;
}>;
export type AgentFindSkillResponse = Readonly<{
  status: "ready" | "partial";
  unreadRoots: readonly Readonly<{ root: EntryRef; name: string; reason: string }>[];
  matches: readonly AgentSkillMatch[];
  identityFindings: readonly Readonly<{ kind: string; roots: readonly EntryRef[]; examples: readonly string[] }>[];
}>;
export type AgentProjectAssetsResponse = Readonly<{
  status: "ready";
  projectId: string;
  managed: readonly Readonly<{ bindingId: string; harness: string; artifactPath: string; state: string }>[];
  unmanaged: readonly Pick<ObservedArtifact, "id" | "kind" | "relativePath" | "displayPath" | "summary">[];
}>;
export type AgentDriftResponse = Readonly<{
  status: "ready";
  bindings: readonly Readonly<{
    bindingId: string;
    projectId: string;
    harness: string;
    projectAvailable: boolean;
    reason?: string;
    state: "current" | "update" | "conflict" | "unavailable";
    artifactPath: string;
  }>[];
}>;

type RecordValue = Record<string, unknown>;
const MAX_TEXT = 240;
const HARNESSES: readonly AgentHarness[] = ["claude-code", "codex"];

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}
function text(value: unknown, label: string, max = MAX_TEXT): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value.trim();
}
function id(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}
function path(value: unknown, label: string): string {
  const result = text(value, label, 512).replaceAll("\\", "/");
  if (
    result.startsWith("/") ||
    /^[A-Za-z]:\//u.test(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${label} must be relative.`);
  return result;
}
function harness(value: unknown): AgentHarness {
  if (!HARNESSES.includes(value as AgentHarness)) throw new Error("Harness is invalid.");
  return value as AgentHarness;
}
function strings<T extends string>(value: unknown, label: string, parser: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const result = value.map(parser);
  if (new Set(result).size !== result.length) throw new Error(`${label} must be unique.`);
  return result;
}

function iso(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (new Date(result).toISOString() !== result) throw new Error(`${label} is invalid.`);
  return result;
}

function parseStoredTarget(value: unknown): StoredCaptureTarget {
  const target = record(value, "Capture target");
  keys(target, ["packageId", "newPackageName", "description", "projectTo"], "Capture target");
  const packageId = target.packageId === undefined ? undefined : path(target.packageId, "Package id");
  const newPackageName = target.newPackageName === undefined ? undefined : text(target.newPackageName, "Package name");
  const projectTo =
    target.projectTo === undefined ? undefined : strings(target.projectTo, "Target harnesses", (item) => harness(item));
  if (packageId !== undefined && projectTo !== undefined)
    throw new Error("Package targets cannot request projections.");
  if (Boolean(packageId) === Boolean(newPackageName))
    throw new Error("Capture target must choose one package destination.");
  if (packageId) return { packageId };
  return {
    newPackageName: newPackageName!,
    ...(target.description === undefined ? {} : { description: parsePluginDescription(target.description) }),
    ...(projectTo ? { projectTo } : {}),
  };
}

function parseTarget(value: unknown): AgentCaptureTarget {
  const target = parseStoredTarget(value);
  return target.newPackageName === undefined
    ? target
    : { ...target, description: parsePluginDescription(target.description) };
}

function parseStoredAgentWriteRequest(value: unknown): StoredAgentWriteRequest {
  const request = record(value, "Stored agent write request");
  if (request.kind !== "import-artifact") return parseAgentWriteRequest(request);
  keys(request, ["kind", "projectId", "relativePath", "target"], "Capture request");
  return {
    kind: "import-artifact",
    projectId: id(request.projectId, "Project id"),
    relativePath: path(request.relativePath, "Artifact path"),
    target: parseStoredTarget(request.target),
  };
}

export function parseAgentWriteRequest(value: unknown): AgentWriteRequest {
  const request = record(value, "Agent write request");
  if (request.kind === "link-storefront") return linkStorefrontSchema.parse(request);
  if (request.kind === "register-project") return registerProjectSchema.parse(request);
  if (request.kind === "install-external-skill") return externalInstallSchema.parse(request);
  if (request.kind === "import-artifact") {
    keys(request, ["kind", "projectId", "relativePath", "target"], "Capture request");
    return {
      kind: "import-artifact",
      projectId: id(request.projectId, "Project id"),
      relativePath: path(request.relativePath, "Artifact path"),
      target: parseTarget(request.target),
    };
  }
  if (request.kind === "make-compatible") {
    keys(request, ["kind", "sourceId", "harness", "packageId"], "Compatibility request");
    return {
      kind: "make-compatible",
      sourceId: id(request.sourceId, "Source id"),
      harness: harness(request.harness),
      ...(request.packageId === undefined ? {} : { packageId: path(request.packageId, "Package id") }),
    };
  }
  if (request.kind === "publish-plugin") return parsePublishPluginRequest(request);
  if (request.kind === "write-skill") return parseWriteSkillRequest(request);
  if (request.kind === "update-and-maintain" || request.kind === "maintain-current")
    return parseSkillPropagationIntent(request);
  if (request.kind === "assign") {
    keys(request, ["kind", "artifactPath", "sourceId", "packageId", "projectIds", "harnesses"], "Assignment request");
    return {
      kind: "assign",
      artifactPath: path(request.artifactPath, "Artifact path"),
      sourceId: id(request.sourceId, "Source id"),
      packageId: path(request.packageId, "Package id"),
      projectIds: strings(request.projectIds, "Project ids", (item) => id(item, "Project id")),
      ...(request.harnesses === undefined
        ? {}
        : { harnesses: strings(request.harnesses, "Assignment harnesses", (item) => harness(item)) }),
    };
  }
  if (request.kind === "remove-skill") {
    keys(request, ["kind", "bindingIds"], "Skill removal request");
    return {
      kind: "remove-skill",
      bindingIds: strings(request.bindingIds, "Binding ids", (item) => id(item, "Binding id")),
    };
  }
  if (request.kind === "restore-skill") {
    keys(request, ["kind", "operationId"], "Skill restore request");
    return { kind: "restore-skill", operationId: id(request.operationId, "Operation id") };
  }
  throw new Error("Agent write request kind is invalid.");
}

export function parseEmptyAgentsRequest(value: unknown): void {
  const request = record(value, "Agents request");
  keys(request, [], "Agents request");
}
function parsePlan(value: unknown): AgentPlan {
  const plan = record(value, "Agent plan");
  if (plan.kind === "assign") {
    keys(plan, ["kind", "plans", "bindings"], "Assignment plan");
    if (!Array.isArray(plan.plans)) throw new Error("Assignment plan is invalid.");
    return {
      kind: "assign",
      plans: plan.plans.map((item) => {
        const projectPlan = record(item, "Project plan");
        keys(projectPlan, ["projectId", "planId", "status", "actions"], "Project plan");
        if (
          !Array.isArray(projectPlan.actions) ||
          !["ready", "conflict", "blocked"].includes(String(projectPlan.status))
        )
          throw new Error("Project plan is invalid.");
        return {
          projectId: id(projectPlan.projectId, "Project id"),
          planId: id(projectPlan.planId, "Plan id"),
          status: projectPlan.status as "ready" | "conflict" | "blocked",
          actions: projectPlan.actions as ProjectPlan["actions"],
        };
      }),
      ...(plan.bindings === undefined
        ? {}
        : {
            bindings: Array.isArray(plan.bindings)
              ? plan.bindings.map(parseBinding)
              : (() => {
                  throw new Error("Assignment bindings are invalid.");
                })(),
          }),
    };
  }
  keys(
    plan,
    [
      "storefrontLink",
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
      "publication",
    ],
    "Operation plan",
  );
  if (!Array.isArray(plan.actions) || typeof plan.git !== "object" || plan.git === null || Array.isArray(plan.git))
    throw new Error("Operation plan is invalid.");
  const git = plan.git as Record<string, unknown>;
  keys(git, ["mode", "warnings"], "Operation plan Git state");
  if (!OPERATION_KINDS.includes(plan.kind as OperationPlan["kind"])) throw new Error("Operation plan kind is invalid.");
  if (!Array.isArray(git.warnings)) throw new Error("Operation plan Git state is invalid.");
  if (plan.findings !== undefined) {
    if (!Array.isArray(plan.findings)) throw new Error("Operation findings are invalid.");
    for (const item of plan.findings) {
      const finding = record(item, "Operation finding");
      keys(finding, ["severity", "code", "message", "fix"], "Operation finding");
      if (finding.severity !== "error" && finding.severity !== "warning")
        throw new Error("Operation finding is invalid.");
      text(finding.code, "Finding code", 80);
      text(finding.message, "Finding message", 1024);
      text(finding.fix, "Finding fix", 1024);
    }
  }
  return {
    ...(plan.storefrontLink === undefined ? {} : { storefrontLink: parseStorefrontLinkPlan(plan.storefrontLink) }),
    ...(plan.projectRegistration === undefined
      ? {}
      : { projectRegistration: parseProjectRegistrationPlan(plan.projectRegistration) }),
    planId: id(plan.planId, "Plan id"),
    kind: text(plan.kind, "Operation kind", 40) as OperationPlan["kind"],
    displayTarget: text(plan.displayTarget, "Display target", 512),
    ...(plan.packageId === undefined ? {} : { packageId: path(plan.packageId, "Package id") }),
    actions: plan.actions as OperationPlan["actions"],
    git: { mode: text(git.mode, "Git mode", 40) as OperationPlan["git"]["mode"], warnings: git.warnings as string[] },
    ...(plan.visibleIn === undefined ? {} : { visibleIn: plan.visibleIn as OperationPlan["visibleIn"] }),
    ...(plan.report === undefined ? {} : { report: plan.report as OperationPlan["report"] }),
    ...(plan.findings === undefined ? {} : { findings: plan.findings as OperationPlan["findings"] }),
    ...(plan.notes === undefined ? {} : { notes: plan.notes as OperationPlan["notes"] }),
    ...(plan.publication === undefined ? {} : { publication: parsePublicationPlanSummary(plan.publication) }),
    ...(plan.harnesses === undefined ? {} : { harnesses: plan.harnesses as OperationPlan["harnesses"] }),
  };
}
function parseAgentRequest(value: unknown): AgentRequest {
  const request = record(value, "Agent request");
  keys(
    request,
    [
      "requestId",
      "createdAt",
      "expiresAt",
      "harness",
      "sessionName",
      "cwd",
      "request",
      "plan",
      "approval",
      "approvalReason",
      "status",
      "intentId",
      "skillIntent",
      "receiptId",
      "receiptIds",
      "applyOutcome",
      "consent",
    ],
    "Agent request",
  );
  if (!["pending", "awaiting-agent", "approved", "declined", "expired"].includes(String(request.status)))
    throw new Error("Agent request status is invalid.");
  if (request.harness !== undefined) harness(request.harness);
  const terminal = parseAgentTerminalReferences(
    request.status,
    request.receiptId,
    request.receiptIds,
    request.applyOutcome,
  );
  const intentId = request.intentId === undefined ? undefined : id(request.intentId, "Skill intent id");
  const skillIntent = request.skillIntent === undefined ? undefined : parseSkillIntent(request.skillIntent);
  if ((intentId === undefined) !== (skillIntent === undefined))
    throw new Error("Agent skill intent reference is incomplete.");
  return {
    requestId: id(request.requestId, "Request id"),
    createdAt: iso(request.createdAt, "Created at"),
    expiresAt: iso(request.expiresAt, "Expires at"),
    ...(request.harness === undefined ? {} : { harness: harness(request.harness) }),
    ...(request.sessionName === undefined ? {} : { sessionName: text(request.sessionName, "Session name", 120) }),
    ...(request.cwd === undefined ? {} : { cwd: text(request.cwd, "Working directory", 512) }),
    request: parseStoredAgentWriteRequest(request.request),
    plan: parsePlan(request.plan),
    approval: request.approval === undefined ? "omni" : parseApproval(request.approval),
    status: request.status as AgentRequest["status"],
    ...(request.approvalReason === undefined ? {} : { approvalReason: parseApprovalReason(request.approvalReason) }),
    ...(intentId === undefined ? {} : { intentId, skillIntent }),
    ...(request.receiptId === undefined ? {} : { receiptId: id(request.receiptId, "Receipt id") }),
    ...terminal,
    ...(request.consent === undefined ? {} : { consent: parseConsent(request.consent) }),
  };
}

function parseApproval(value: unknown): ApprovalMode {
  if (value !== "conversation" && value !== "omni") throw new Error("Agent approval is invalid.");
  return value;
}

function parseConsent(value: unknown): AgentConsent {
  const consent = record(value, "Agent consent");
  keys(consent, ["mode", "at", "harness", "sessionName"], "Agent consent");
  if (consent.harness !== undefined) harness(consent.harness);
  return {
    mode: parseApproval(consent.mode),
    at: iso(consent.at, "Consent time"),
    ...(consent.harness === undefined ? {} : { harness: harness(consent.harness) }),
    ...(consent.sessionName === undefined ? {} : { sessionName: text(consent.sessionName, "Consent session", 120) }),
  };
}
export function parseAgentRequestResponse(value: unknown): AgentListResponse {
  const response = record(value, "Agent list response");
  keys(response, ["status", "requests"], "Agent list response");
  if (response.status !== "ready" || !Array.isArray(response.requests))
    throw new Error("Agent list response is invalid.");
  return { status: "ready", requests: response.requests.map(parseAgentRequest) };
}
export function parseAgentStatusResponse(value: unknown): AgentStatus {
  const response = record(value, "Agent status response");
  keys(response, ["socketPath", "tokenCreatedAt", "counts", "harnesses", "appVersion"], "Agent status response");
  const counts = record(response.counts, "Agent counts");
  keys(counts, ["pending", "today", "total"], "Agent counts");
  if (
    ![counts.pending, counts.today, counts.total].every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    )
  )
    throw new Error("Agent counts are invalid.");
  const pending = counts.pending;
  const today = counts.today;
  const total = counts.total;
  if (typeof pending !== "number" || typeof today !== "number" || typeof total !== "number")
    throw new Error("Agent counts are invalid.");
  return {
    ...(response.appVersion === undefined ? {} : { appVersion: text(response.appVersion, "App version", 128) }),
    socketPath: text(response.socketPath, "Socket path", 512),
    tokenCreatedAt: iso(response.tokenCreatedAt, "Token created at"),
    counts: { pending, today, total },
    harnesses: response.harnesses === undefined ? [] : parseHarnesses(response.harnesses),
  };
}

function parseHarnesses(value: unknown): AgentStatus["harnesses"] {
  if (!Array.isArray(value)) throw new Error("Agent harnesses are invalid.");
  return value.map((item) => {
    const harness = record(item, "Agent harness");
    keys(
      harness,
      ["harness", "detected", "registered", "settingsPath", "skillsPath", "current", "skills", "guard", "lastSeenAt"],
      "Agent harness",
    );
    if (harness.harness !== "claude-code" && harness.harness !== "codex") throw new Error("Agent harness is invalid.");
    if (
      typeof harness.detected !== "boolean" ||
      typeof harness.registered !== "boolean" ||
      typeof harness.current !== "boolean" ||
      typeof harness.guard !== "boolean"
    )
      throw new Error("Agent harness state is invalid.");
    if (!Array.isArray(harness.skills)) throw new Error("Agent harness skills are invalid.");
    const skills: AgentStatus["harnesses"][number]["skills"] = harness.skills.map((item) => {
      const skill = record(item, "Agent skill");
      keys(skill, ["name", "state"], "Agent skill");
      if (typeof skill.name !== "string" || !skill.name.trim()) throw new Error("Agent skill name is invalid.");
      if (
        skill.state !== "installed" &&
        skill.state !== "outdated" &&
        skill.state !== "missing" &&
        skill.state !== "foreign"
      )
        throw new Error("Agent skill state is invalid.");
      return { name: skill.name, state: skill.state };
    });
    return {
      harness: harness.harness,
      detected: harness.detected,
      registered: harness.registered,
      settingsPath: text(harness.settingsPath, "Settings path", 512),
      skillsPath: text(harness.skillsPath, "Skills path", 512),
      current: harness.current,
      skills,
      guard: harness.guard,
      ...(harness.lastSeenAt === undefined ? {} : { lastSeenAt: iso(harness.lastSeenAt, "Last seen at") }),
    };
  });
}
export function parseAgentMutationResponse(value: unknown): AgentRequest {
  return parseAgentRequest(value);
}

export interface AgentsDesktopApi {
  onOpenAgentRequest?(listener: (requestId: string) => void): () => void;
  refreshAgentRequest?(requestId: string): Promise<AgentRequest>;
  listAgentRequests(): Promise<AgentListResponse>;
  beginAgentApply(request: AgentBeginApplyRequest): Promise<AgentApplyAuthorization>;
  endAgentApply(request: AgentEndApplyRequest): Promise<void>;
  resolveAgentRequest(request: AgentResolveRequest): Promise<AgentRequest>;
  declineAgentRequest(request: AgentDeclineRequest): Promise<AgentRequest>;
  getAgentStatus(): Promise<AgentStatus>;
  rotateAgentToken(): Promise<AgentStatus>;
}
