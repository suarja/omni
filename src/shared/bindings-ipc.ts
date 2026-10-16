import type { Binding, ProjectPlan, TargetEvidence } from "../domain/assignment-plan";
import type { HarnessId, TargetKind } from "../domain/harness-targets";

export const BINDINGS_IPC_CHANNELS = {
  list: "omni:bindings:list",
  preview: "omni:bindings:preview",
  save: "omni:bindings:save",
  remove: "omni:bindings:remove",
} as const;

export type BindingsPreviewRequest = Readonly<{
  source: Readonly<{ id: string; grantHandle: string }>;
  packageId: string;
  // Omitted: preview every artifact of the package (one unit per artifact).
  artifactPath?: string;
  projects: readonly Readonly<{ projectId: string; grantHandle: string; harnessIds: readonly HarnessId[] }>[];
}>;
export type BindingsSaveRequest = Readonly<{ bindings: readonly Binding[] }>;
export type BindingsRemoveRequest = Readonly<{ bindingId: string }>;
export type BindingsListResponse =
  | Readonly<{ status: "ready"; bindings: readonly Binding[] }>
  | Readonly<{ status: "corrupt"; diagnostic: string; recoveryAvailable: boolean }>;
export type BindingsPreviewUnit = Readonly<{ kind: TargetKind; id: string; artifactPath: string; contentHash: string }>;
export type BindingsPreviewResponse =
  | Readonly<{
      status: "ready";
      units: readonly BindingsPreviewUnit[];
      plans: readonly ProjectPlan[];
      bindings?: readonly Binding[];
    }>
  | Readonly<{ status: "denied" }>;
export type BindingsMutationResponse = BindingsListResponse;

type RecordValue = Record<string, unknown>;
const KINDS: readonly TargetKind[] = ["skill", "instruction", "command", "agent", "hook", "mcp-config"];
const HARNESSES: readonly HarnessId[] = ["claude-code", "codex", "cursor"];

export function assertKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label} has an unexpected field "${key}".`);
}

function assertRecord(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function readOpaque(value: unknown, label: string): string {
  const text = readText(value, label);
  if (text.includes("/") || text.includes("\\") || text.includes("..") || /[\u0000-\u001f\u007f-\u009f]/u.test(text))
    throw new Error(`${label} must be opaque.`);
  return text;
}

function readRelativePath(value: unknown, label: string): string {
  const path = readText(value, label).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(path)
  )
    throw new Error(`${label} must be relative.`);
  return path;
}

function readHash(value: unknown, label: string): string {
  const hash = readText(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} must be a lowercase SHA-256 hash.`);
  return hash;
}

function readHarness(value: unknown): HarnessId {
  if (!HARNESSES.includes(value as HarnessId)) throw new Error("Harness id is invalid.");
  return value as HarnessId;
}

function readKind(value: unknown): TargetKind {
  if (!KINDS.includes(value as TargetKind)) throw new Error("Binding kind is invalid.");
  return value as TargetKind;
}

export function parseBinding(value: unknown): Binding {
  const binding = assertRecord(value, "Binding");
  assertKeys(
    binding,
    [
      "bindingId",
      "sourceId",
      "packageId",
      "artifactPath",
      "kind",
      "projectId",
      "harnessId",
      "boundHash",
      "ownedHash",
      "createdAt",
    ],
    "Binding",
  );
  return {
    bindingId: readOpaque(binding.bindingId, "Binding id"),
    sourceId: readOpaque(binding.sourceId, "Source id"),
    packageId: readRelativePath(binding.packageId, "Package id"),
    artifactPath: readRelativePath(binding.artifactPath, "Artifact path"),
    kind: readKind(binding.kind),
    projectId: readOpaque(binding.projectId, "Project id"),
    harnessId: readHarness(binding.harnessId),
    boundHash: readHash(binding.boundHash, "Bound hash"),
    ...(binding.ownedHash === undefined ? {} : { ownedHash: readHash(binding.ownedHash, "Owned hash") }),
    createdAt: readText(binding.createdAt, "Binding created at"),
  };
}

function parseTargetEvidence(value: unknown): TargetEvidence {
  const target = assertRecord(value, "Target evidence");
  assertKeys(
    target,
    ["harnessId", "relativePath", "exists", "contentHash", "symlinkTarget", "providerManaged"],
    "Target evidence",
  );
  if (typeof target.exists !== "boolean" || typeof target.providerManaged !== "boolean")
    throw new Error("Target evidence flags are invalid.");
  return {
    harnessId: readHarness(target.harnessId),
    relativePath: readRelativePath(target.relativePath, "Target path"),
    exists: target.exists,
    ...(target.contentHash === undefined ? {} : { contentHash: readHash(target.contentHash, "Target hash") }),
    ...(target.symlinkTarget === undefined
      ? {}
      : { symlinkTarget: readRelativePath(target.symlinkTarget, "Symlink target") }),
    providerManaged: target.providerManaged,
  };
}

function parseAction(value: unknown): ProjectPlan["actions"][number] {
  const action = assertRecord(value, "Assignment action");
  assertKeys(action, ["bindingId", "harnessId", "kind", "relativePath", "state", "reason"], "Assignment action");
  const state = action.state;
  if (!["add", "current", "update", "linked", "conflict", "blocked"].includes(String(state)))
    throw new Error("Assignment action state is invalid.");
  return {
    bindingId: readOpaque(action.bindingId, "Binding id"),
    harnessId: readHarness(action.harnessId),
    kind: readKind(action.kind),
    relativePath: readRelativePath(action.relativePath, "Target path"),
    state: state as ProjectPlan["actions"][number]["state"],
    ...(action.reason === undefined ? {} : { reason: readText(action.reason, "Assignment reason") }),
  };
}

function parseProjectPlan(value: unknown): ProjectPlan {
  const plan = assertRecord(value, "Project plan");
  assertKeys(plan, ["projectId", "planId", "status", "actions"], "Project plan");
  if (plan.status !== "ready" && plan.status !== "conflict" && plan.status !== "blocked")
    throw new Error("Project plan status is invalid.");
  if (!Array.isArray(plan.actions)) throw new Error("Project plan actions must be an array.");
  return {
    projectId: readOpaque(plan.projectId, "Project id"),
    planId: readOpaque(plan.planId, "Plan id"),
    status: plan.status,
    actions: plan.actions.map(parseAction),
  };
}

function parsePreviewUnit(value: unknown): BindingsPreviewUnit {
  const unit = assertRecord(value, "Bindings preview unit");
  assertKeys(unit, ["kind", "id", "artifactPath", "contentHash"], "Bindings preview unit");
  return {
    kind: readKind(unit.kind),
    id: readOpaque(unit.id, "Unit id"),
    artifactPath: readRelativePath(unit.artifactPath, "Unit artifact path"),
    contentHash: readHash(unit.contentHash, "Unit hash"),
  };
}

function parseCorrupt(value: RecordValue, label: string): BindingsListResponse {
  assertKeys(value, ["status", "diagnostic", "recoveryAvailable"], label);
  if (value.status !== "corrupt" || typeof value.recoveryAvailable !== "boolean")
    throw new Error(`${label} is invalid.`);
  return {
    status: "corrupt",
    diagnostic: readText(value.diagnostic, "Bindings diagnostic"),
    recoveryAvailable: value.recoveryAvailable,
  };
}

export function parseEmptyBindingsRequest(value: unknown): void {
  const request = assertRecord(value, "Bindings request");
  assertKeys(request, [], "Bindings request");
}

export function parseBindingsPreviewRequest(value: unknown): BindingsPreviewRequest {
  const request = assertRecord(value, "Bindings preview request");
  assertKeys(request, ["source", "packageId", "artifactPath", "projects"], "Bindings preview request");
  const source = assertRecord(request.source, "Bindings source");
  assertKeys(source, ["id", "grantHandle"], "Bindings source");
  if (!Array.isArray(request.projects)) throw new Error("Bindings projects must be an array.");
  const projects = request.projects.map((value) => {
    const project = assertRecord(value, "Bindings project");
    assertKeys(project, ["projectId", "grantHandle", "harnessIds"], "Bindings project");
    if (!Array.isArray(project.harnessIds)) throw new Error("Harness ids must be an array.");
    const harnessIds = project.harnessIds.map(readHarness);
    if (new Set(harnessIds).size !== harnessIds.length) throw new Error("Harness ids must be unique.");
    return {
      projectId: readOpaque(project.projectId, "Project id"),
      grantHandle: readOpaque(project.grantHandle, "Grant handle"),
      harnessIds,
    };
  });
  return {
    source: { id: readOpaque(source.id, "Source id"), grantHandle: readOpaque(source.grantHandle, "Grant handle") },
    packageId: readRelativePath(request.packageId, "Package id"),
    ...(request.artifactPath === undefined
      ? {}
      : { artifactPath: readRelativePath(request.artifactPath, "Artifact path") }),
    projects,
  };
}

export function parseBindingsSaveRequest(value: unknown): BindingsSaveRequest {
  const request = assertRecord(value, "Bindings save request");
  assertKeys(request, ["bindings"], "Bindings save request");
  if (!Array.isArray(request.bindings)) throw new Error("Bindings must be an array.");
  return { bindings: request.bindings.map(parseBinding) };
}

export function parseBindingsRemoveRequest(value: unknown): BindingsRemoveRequest {
  const request = assertRecord(value, "Bindings remove request");
  assertKeys(request, ["bindingId"], "Bindings remove request");
  return { bindingId: readOpaque(request.bindingId, "Binding id") };
}

export function parseBindingsListResponse(value: unknown): BindingsListResponse {
  const response = assertRecord(value, "Bindings list response");
  if (response.status === "corrupt") return parseCorrupt(response, "Bindings corrupt response");
  assertKeys(response, ["status", "bindings"], "Bindings list response");
  if (response.status !== "ready" || !Array.isArray(response.bindings))
    throw new Error("Bindings list response is invalid.");
  return { status: "ready", bindings: response.bindings.map(parseBinding) };
}

export function parseBindingsPreviewResponse(value: unknown): BindingsPreviewResponse {
  const response = assertRecord(value, "Bindings preview response");
  if (response.status === "denied") {
    assertKeys(response, ["status"], "Denied bindings preview response");
    return { status: "denied" };
  }
  assertKeys(response, ["status", "units", "plans", "bindings"], "Bindings preview response");
  if (
    response.status !== "ready" ||
    !Array.isArray(response.units) ||
    !Array.isArray(response.plans) ||
    (response.bindings !== undefined && !Array.isArray(response.bindings))
  )
    throw new Error("Bindings preview response is invalid.");
  return {
    status: "ready",
    units: response.units.map(parsePreviewUnit),
    plans: response.plans.map(parseProjectPlan),
    ...(response.bindings === undefined ? {} : { bindings: response.bindings.map(parseBinding) }),
  };
}

export function parseBindingsMutationResponse(value: unknown): BindingsMutationResponse {
  return parseBindingsListResponse(value);
}

export interface BindingsDesktopApi {
  listBindings(): Promise<BindingsListResponse>;
  previewBindings(request: BindingsPreviewRequest): Promise<BindingsPreviewResponse>;
  saveBindings(request: BindingsSaveRequest): Promise<BindingsMutationResponse>;
  removeBinding(request: BindingsRemoveRequest): Promise<BindingsMutationResponse>;
}
