import { matchesBindingSourceRepresentation } from "../domain/skill-reconciliation/legacy-binding-bridge";
import type { SkillLocationKey, SourceSkillRef, SkillRevision } from "../domain/skill-reconciliation/types";
import type { Binding } from "../domain/assignment-plan";
import type { ManagedSkillUse } from "../domain/skill-reconciliation/types";
import { parseManagedSkillUse, parseSkillRevision } from "../domain/skill-reconciliation/validation";
import { parseBinding } from "./bindings-ipc";
import type { WriteSkillRequest } from "./operations-write-skill-ipc";
import { parseWriteSkillRequest } from "./operations-write-skill-ipc";

export type SkillPropagationIntent =
  | Readonly<{
      kind: "update-and-maintain";
      source: SourceSkillRef;
      request: WriteSkillRequest;
      locations?: readonly SkillLocationKey[];
    }>
  | Readonly<{
      kind: "maintain-current";
      source: SourceSkillRef;
      locations?: readonly SkillLocationKey[];
      retryOf?: string;
    }>;

export type SkillPropagationPlanState =
  "current" | "already-current" | "eligible" | "retained-local" | "withheld" | "unavailable";

export type SkillPropagationTarget = Readonly<{
  skillId?: string;
  location: SkillLocationKey;
  bindingId?: string;
  baseRevisionId?: string;
  state: SkillPropagationPlanState;
  sourceRevision?: SkillRevision;
  localRevision?: SkillRevision;
  baseRevision?: SkillRevision;
  projectRootIdentity?: string;
  reason?: string;
  files?: readonly Readonly<{
    path: string;
    state: "add" | "change" | "delete" | "unchanged";
    byteLength?: number;
    beforeHash?: string;
    afterHash?: string;
  }>[];
  result?: "applied" | "no-op" | "retained-local" | "unavailable" | "failed" | "unknown" | "pending" | "restored";
}>;

export type SkillPropagationSummary = Readonly<{
  mode: "update-and-maintain" | "maintain-current";
  source: SourceSkillRef;
  retryOf?: string;
  sourceRootIdentity?: string;
  relationshipRevision?: number;
  targets: readonly SkillPropagationTarget[];
}>;

export type SkillPropagationCandidate = Readonly<{
  skillId: string;
  locations: readonly SkillLocationKey[];
}>;

export type SkillPropagationReceiptPointer = Readonly<{
  intentId: string;
  stepId: string;
  skillId: string;
  sourceId: string;
  location: SkillLocationKey;
  rootIdentity: string;
  beforeRevision: SkillRevision;
  afterRevision: SkillRevision;
  previousUse: ManagedSkillUse;
  currentUse: ManagedSkillUse;
  previousBinding: Binding;
  currentBinding: Binding;
  backupPath: string;
}>;

type RecordValue = Record<string, unknown>;
const HARNESSES = ["claude-code", "codex", "cursor"] as const;

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

function parseSource(value: unknown): SourceSkillRef {
  const source = record(value, "Skill propagation source");
  keys(source, ["sourceId", "packageId", "artifactPath"], "Skill propagation source");
  return {
    sourceId: id(source.sourceId, "Source id"),
    packageId: relativePath(source.packageId, "Package id"),
    artifactPath: relativePath(source.artifactPath, "Artifact path"),
  };
}

export function parseSkillPropagationCandidatesRequest(value: unknown): SourceSkillRef {
  const request = record(value, "Skill propagation candidates request");
  keys(request, ["source"], "Skill propagation candidates request");
  return parseSource(request.source);
}

export function parseSkillPropagationCandidates(value: unknown): readonly SkillPropagationCandidate[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Skill propagation candidates are invalid.");
  const candidates = value.map((item) => {
    const candidate = record(item, "Skill propagation candidate");
    keys(candidate, ["skillId", "locations"], "Skill propagation candidate");
    const locations = parseLocations(candidate.locations);
    return { skillId: id(candidate.skillId, "Logical skill id"), locations };
  });
  if (new Set(candidates.map(({ skillId }) => skillId)).size !== candidates.length)
    throw new Error("Skill propagation candidates are duplicated.");
  return candidates;
}

function parseLocation(value: unknown): SkillLocationKey {
  const location = record(value, "Skill propagation target");
  keys(location, ["projectId", "harnessId", "folderPath"], "Skill propagation target");
  if (!HARNESSES.includes(location.harnessId as (typeof HARNESSES)[number])) throw new Error("Harness id is invalid.");
  return {
    projectId: id(location.projectId, "Project id"),
    harnessId: location.harnessId as SkillLocationKey["harnessId"],
    folderPath: relativePath(location.folderPath, "Skill folder path"),
  };
}

function parseLocations(value: unknown): readonly SkillLocationKey[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    throw new Error("Skill propagation targets are invalid.");
  const locations = value.map(parseLocation);
  const keys = locations.map((location) =>
    JSON.stringify([location.projectId, location.harnessId, location.folderPath]),
  );
  if (new Set(keys).size !== keys.length) throw new Error("Skill propagation targets must be unique.");
  return locations;
}

export function parseSkillPropagationIntent(value: unknown): SkillPropagationIntent {
  const intent = record(value, "Skill propagation intent");
  if (intent.kind === "update-and-maintain") {
    keys(intent, ["kind", "source", "request", "locations"], "Update and maintain intent");
    const source = parseSource(intent.source);
    const request = parseWriteSkillRequest(intent.request);
    if (
      request.mode !== "update" ||
      request.sourceId !== source.sourceId ||
      request.packageId !== source.packageId ||
      source.artifactPath !== `skills/${request.folderName}`
    )
      throw new Error("The source update does not match the selected skill.");
    return {
      kind: "update-and-maintain",
      source,
      request,
      ...(intent.locations === undefined ? {} : { locations: parseLocations(intent.locations) }),
    };
  }
  if (intent.kind === "maintain-current") {
    keys(intent, ["kind", "source", "locations", "retryOf"], "Maintain current intent");
    return {
      kind: "maintain-current",
      source: parseSource(intent.source),
      ...(intent.locations === undefined ? {} : { locations: parseLocations(intent.locations) }),
      ...(intent.retryOf === undefined ? {} : { retryOf: id(intent.retryOf, "Original operation id") }),
    };
  }
  throw new Error("Skill propagation intent kind is invalid.");
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function parsePropagationTarget(value: unknown): SkillPropagationTarget {
  const target = record(value, "Skill propagation result target");
  keys(
    target,
    [
      "location",
      "skillId",
      "bindingId",
      "baseRevisionId",
      "state",
      "sourceRevision",
      "localRevision",
      "baseRevision",
      "projectRootIdentity",
      "reason",
      "files",
      "result",
    ],
    "Skill propagation result target",
  );
  const states: readonly SkillPropagationPlanState[] = [
    "current",
    "already-current",
    "eligible",
    "retained-local",
    "withheld",
    "unavailable",
  ];
  if (!states.includes(target.state as SkillPropagationPlanState))
    throw new Error("Skill propagation target state is invalid.");
  if (
    ["current", "already-current", "eligible", "retained-local"].includes(String(target.state)) &&
    target.skillId === undefined
  )
    throw new Error("Managed propagation targets require a logical skill id.");
  if (target.files !== undefined && (!Array.isArray(target.files) || target.files.length > 512))
    throw new Error("Skill propagation target files are invalid.");
  const files = (target.files as unknown[] | undefined)?.map((value) => {
    const file = record(value, "Skill propagation file");
    keys(file, ["path", "state", "byteLength", "beforeHash", "afterHash"], "Skill propagation file");
    const fileState = file.state;
    if (!new Set(["add", "change", "delete", "unchanged"]).has(String(fileState)))
      throw new Error("Skill propagation file state is invalid.");
    if (file.byteLength !== undefined && (!Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 0))
      throw new Error("Skill propagation file length is invalid.");
    return {
      path: relativePath(file.path, "Skill propagation file path"),
      state: fileState as "add" | "change" | "delete" | "unchanged",
      ...(file.byteLength === undefined ? {} : { byteLength: file.byteLength as number }),
      ...(file.beforeHash === undefined ? {} : { beforeHash: parseHash(file.beforeHash, "Before hash") }),
      ...(file.afterHash === undefined ? {} : { afterHash: parseHash(file.afterHash, "After hash") }),
    };
  });
  if (files && new Set(files.map(({ path }) => path)).size !== files.length)
    throw new Error("Skill propagation files are duplicated.");
  const resultStatuses = [
    "applied",
    "no-op",
    "retained-local",
    "unavailable",
    "failed",
    "unknown",
    "pending",
    "restored",
  ];
  if (target.result !== undefined && !resultStatuses.includes(String(target.result)))
    throw new Error("Skill propagation target result is invalid.");
  if (target.reason !== undefined && typeof target.reason !== "string")
    throw new Error("Skill propagation target reason is invalid.");
  return {
    location: parseLocation(target.location),
    ...(target.skillId === undefined ? {} : { skillId: id(target.skillId, "Logical skill id") }),
    ...(target.bindingId === undefined ? {} : { bindingId: id(target.bindingId, "Binding id") }),
    ...(target.baseRevisionId === undefined ? {} : { baseRevisionId: id(target.baseRevisionId, "Base revision id") }),
    state: target.state as SkillPropagationPlanState,
    ...(target.sourceRevision === undefined ? {} : { sourceRevision: parseSkillRevision(target.sourceRevision) }),
    ...(target.localRevision === undefined ? {} : { localRevision: parseSkillRevision(target.localRevision) }),
    ...(target.baseRevision === undefined ? {} : { baseRevision: parseSkillRevision(target.baseRevision) }),
    ...(target.projectRootIdentity === undefined
      ? {}
      : { projectRootIdentity: id(target.projectRootIdentity, "Project root identity") }),
    ...(target.reason === undefined ? {} : { reason: target.reason as string }),
    ...(files === undefined ? {} : { files }),
    ...(target.result === undefined ? {} : { result: target.result as SkillPropagationTarget["result"] }),
  };
}

export function parseSkillPropagationSummary(value: unknown): SkillPropagationSummary {
  const summary = record(value, "Skill propagation summary");
  keys(
    summary,
    ["mode", "source", "retryOf", "sourceRootIdentity", "relationshipRevision", "targets"],
    "Skill propagation summary",
  );
  if (summary.mode !== "update-and-maintain" && summary.mode !== "maintain-current")
    throw new Error("Skill propagation mode is invalid.");
  if (!Array.isArray(summary.targets) || summary.targets.length > 64)
    throw new Error("Skill propagation result targets are invalid.");
  const targets = summary.targets.map(parsePropagationTarget);
  const targetKeys = targets.map(({ location }) =>
    JSON.stringify([location.projectId, location.harnessId, location.folderPath]),
  );
  if (new Set(targetKeys).size !== targetKeys.length)
    throw new Error("Skill propagation result targets are duplicated.");
  return {
    mode: summary.mode,
    source: parseSource(summary.source),
    ...(summary.retryOf === undefined ? {} : { retryOf: id(summary.retryOf, "Original operation id") }),
    ...(summary.sourceRootIdentity === undefined
      ? {}
      : { sourceRootIdentity: id(summary.sourceRootIdentity, "Source root identity") }),
    ...(summary.relationshipRevision === undefined
      ? {}
      : {
          relationshipRevision:
            Number.isSafeInteger(summary.relationshipRevision) && (summary.relationshipRevision as number) >= 0
              ? (summary.relationshipRevision as number)
              : (() => {
                  throw new Error("Relationship revision is invalid.");
                })(),
        }),
    targets,
  };
}

export function parseSkillPropagationReceiptPointer(value: unknown): SkillPropagationReceiptPointer {
  const pointer = record(value, "Skill propagation receipt pointer");
  keys(
    pointer,
    [
      "intentId",
      "stepId",
      "skillId",
      "sourceId",
      "location",
      "rootIdentity",
      "beforeRevision",
      "afterRevision",
      "previousUse",
      "currentUse",
      "previousBinding",
      "currentBinding",
      "backupPath",
    ],
    "Skill propagation receipt pointer",
  );
  const location = parseLocation(pointer.location);
  const previousUse = parseManagedSkillUse(pointer.previousUse);
  const currentUse = parseManagedSkillUse(pointer.currentUse);
  const previousBinding = parseBinding(pointer.previousBinding);
  const currentBinding = parseBinding(pointer.currentBinding);
  const sourceId = id(pointer.sourceId, "Source id");
  const skillId = id(pointer.skillId, "Logical skill id");
  const intentId = id(pointer.intentId, "Original operation id");
  const backupPath = relativePath(pointer.backupPath, "Propagation backup path");
  const sameLocation = (candidate: SkillLocationKey) =>
    candidate.projectId === location.projectId &&
    candidate.harnessId === location.harnessId &&
    candidate.folderPath === location.folderPath;
  const bindingMatchesUse = (binding: Binding, use: ManagedSkillUse) => {
    return (
      binding.kind === "skill" &&
      binding.projectId === location.projectId &&
      binding.harnessId === location.harnessId &&
      matchesBindingSourceRepresentation(binding, use.source)
    );
  };
  if (
    previousUse.skillId !== skillId ||
    currentUse.skillId !== skillId ||
    !sameLocation(previousUse.location) ||
    !sameLocation(currentUse.location) ||
    previousUse.source.sourceId !== sourceId ||
    currentUse.source.sourceId !== sourceId ||
    previousUse.source.packageId !== currentUse.source.packageId ||
    previousUse.source.artifactPath !== currentUse.source.artifactPath ||
    previousBinding.bindingId !== previousUse.bindingId ||
    currentBinding.bindingId !== currentUse.bindingId ||
    !bindingMatchesUse(previousBinding, previousUse) ||
    !bindingMatchesUse(currentBinding, currentUse) ||
    previousBinding.projectId !== location.projectId ||
    currentBinding.projectId !== location.projectId ||
    previousBinding.harnessId !== location.harnessId ||
    currentBinding.harnessId !== location.harnessId
  )
    throw new Error("Skill propagation receipt identity is inconsistent.");
  if (backupPath !== `omni/backups/skill-propagation/${intentId}/${currentBinding.bindingId}`)
    throw new Error("Skill propagation receipt backup path is inconsistent.");
  return {
    intentId,
    stepId: id(pointer.stepId, "Skill step id"),
    skillId,
    sourceId,
    location,
    rootIdentity: id(pointer.rootIdentity, "Root identity"),
    beforeRevision: parseSkillRevision(pointer.beforeRevision),
    afterRevision: parseSkillRevision(pointer.afterRevision),
    previousUse,
    currentUse,
    previousBinding,
    currentBinding,
    backupPath,
  };
}
