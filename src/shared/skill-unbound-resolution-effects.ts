import { parseBinding } from "./bindings-ipc";
import { parseSkillAdoptionBaseReference } from "./skill-adoption-effects";
import {
  parseLogicalSkillRecord,
  parseSkillLocationKey,
  parseManagedSkillUse,
  parseSkillRevision,
  parseSourceSkillRef,
} from "../domain/skill-reconciliation/validation";
import { parseSkillUseEffect } from "./skill-adoption-effects";
import type { Binding } from "../domain/assignment-plan";
import type { SkillAdoptionBaseReference } from "./skill-adoption-effects";
import type { SkillBindingEffect, SkillFileSummary, SkillScope } from "./skill-management-ipc";
import type { OperationAction, OperationKind } from "./operations-ipc";
import type {
  LogicalSkillRecord,
  SkillLocationKey,
  SkillRevision,
  SkillUseEffect,
  SourceSkillRef,
} from "../domain/skill-reconciliation/types";

export type SkillUnboundResolutionEvidence = Readonly<{
  choice: "link-canonical";
  skillId: string;
  storeRevision: number;
  record: LogicalSkillRecord;
  source: Readonly<{ ref: SourceSkillRef; rootIdentity: string; revision: SkillRevision }>;
  local: Readonly<{ location: SkillLocationKey; rootIdentity: string; revision: SkillRevision }>;
  priorManagement: Readonly<{ use: "absent"; binding: "absent"; base: "unknown" }>;
}>;

export type SkillUnboundResolutionDetails = Readonly<{
  choice: "link-canonical";
  skillId: string;
  source: SourceSkillRef;
  location: SkillLocationKey;
  bindingId: string;
  status: "applied" | "restored" | "failed" | "unknown";
}>;

export type SkillUnboundResolutionEnvelope = Readonly<{
  source: readonly Readonly<{ path: string; kind: "file" | "directory"; identity: string }>[];
  local: readonly Readonly<{ path: string; kind: "file" | "directory"; identity: string }>[];
}>;

export type SkillUnboundResolutionRestoreOrigin = Readonly<{ intentId: string; stepId: string }>;

export type SkillUnboundResolutionStepMetadata = Readonly<{
  metadataEffects: readonly SkillUseEffect[];
  baseReferences: readonly SkillAdoptionBaseReference[];
  bindingEffects: readonly SkillBindingEffect[];
  unboundResolutionEvidence: SkillUnboundResolutionEvidence;
  unboundResolutionEnvelope: SkillUnboundResolutionEnvelope;
  unboundResolutionRestoreOrigin?: SkillUnboundResolutionRestoreOrigin;
}>;

type RecordValue = Record<string, unknown>;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function assertKeys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sourceKey(source: SourceSkillRef): string {
  return JSON.stringify([source.sourceId, source.packageId, source.artifactPath]);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function parseEnvelope(value: unknown, label: string): SkillUnboundResolutionEnvelope["source"] {
  if (!Array.isArray(value) || value.length > 2048) throw new Error(`${label} is invalid.`);
  const items = value.map((raw) => {
    const item = record(raw, `${label} entry`);
    assertKeys(item, ["path", "kind", "identity"], `${label} entry`);
    if (
      typeof item.path !== "string" ||
      (item.path !== "." && !/^[^\\/]+(?:\/[^\\/]+)*$/u.test(item.path)) ||
      (item.kind !== "file" && item.kind !== "directory") ||
      typeof item.identity !== "string" ||
      !item.identity
    ) {
      throw new Error(`${label} entry is invalid.`);
    }
    if (item.path !== "." && item.path.split("/").some((part) => part === "." || part === ".."))
      throw new Error(`${label} path is unsafe.`);
    return { path: item.path, kind: item.kind, identity: item.identity } as const;
  });
  if (
    new Set(items.map((item) => item.path)).size !== items.length ||
    !items.some((item) => item.path === "." && item.kind === "directory")
  )
    throw new Error(`${label} entries must be unique and include the selected folder root.`);
  return items.sort((left, right) => left.path.localeCompare(right.path));
}

export function parseSkillUnboundResolutionEnvelope(value: unknown): SkillUnboundResolutionEnvelope {
  const input = record(value, "Unbound resolution tree envelope");
  assertKeys(input, ["source", "local"], "Unbound resolution tree envelope");
  return {
    source: parseEnvelope(input.source, "Source envelope"),
    local: parseEnvelope(input.local, "Local envelope"),
  };
}

export function parseSkillUnboundResolutionRestoreOrigin(value: unknown): SkillUnboundResolutionRestoreOrigin {
  const input = record(value, "Unbound resolution restore origin");
  assertKeys(input, ["intentId", "stepId"], "Unbound resolution restore origin");
  if (
    typeof input.intentId !== "string" ||
    !UUID.test(input.intentId) ||
    typeof input.stepId !== "string" ||
    !UUID.test(input.stepId)
  )
    throw new Error("Unbound resolution restore origin is invalid.");
  return { intentId: input.intentId, stepId: input.stepId };
}

function parseRootRevision(value: unknown, label: string): Readonly<{ rootIdentity: string; revision: SkillRevision }> {
  const input = record(value, label);
  assertKeys(input, ["rootIdentity", "revision"], label);
  return {
    rootIdentity: identity(input.rootIdentity, `${label} root identity`),
    revision: parseSkillRevision(input.revision),
  };
}

export function parseSkillUnboundResolutionEvidence(value: unknown): SkillUnboundResolutionEvidence {
  const input = record(value, "Unbound skill resolution evidence");
  assertKeys(
    input,
    ["choice", "skillId", "storeRevision", "record", "source", "local", "priorManagement"],
    "Unbound skill resolution evidence",
  );
  if (input.choice !== "link-canonical" || typeof input.skillId !== "string" || !UUID.test(input.skillId))
    throw new Error("Unbound skill resolution choice or skill id is invalid.");
  if (!Number.isSafeInteger(input.storeRevision) || Number(input.storeRevision) < 0)
    throw new Error("Unbound skill relationship revision is invalid.");
  const sourceInput = record(input.source, "Unbound skill source evidence");
  assertKeys(sourceInput, ["ref", "rootIdentity", "revision"], "Unbound skill source evidence");
  const source = {
    ref: parseSourceSkillRef(sourceInput.ref),
    rootIdentity: identity(sourceInput.rootIdentity, "Source root identity"),
    revision: parseSkillRevision(sourceInput.revision),
  };
  const localInput = record(input.local, "Unbound skill local evidence");
  assertKeys(localInput, ["location", "rootIdentity", "revision"], "Unbound skill local evidence");
  const local = {
    location: parseSkillLocationKey(localInput.location),
    rootIdentity: identity(localInput.rootIdentity, "Project root identity"),
    revision: parseSkillRevision(localInput.revision),
  };
  const savedRecord = parseLogicalSkillRecord(input.record);
  const prior = record(input.priorManagement, "Prior management evidence");
  assertKeys(prior, ["use", "binding", "base"], "Prior management evidence");
  if (prior.use !== "absent" || prior.binding !== "absent" || prior.base !== "unknown")
    throw new Error("Unbound resolution must preserve exact absent-management evidence.");
  if (
    savedRecord.skillId !== input.skillId ||
    !savedRecord.locations.some((item) => locationKey(item) === locationKey(local.location))
  )
    throw new Error("Unbound resolution evidence does not match its logical record and exact location.");
  return {
    choice: "link-canonical",
    skillId: input.skillId,
    storeRevision: Number(input.storeRevision),
    record: savedRecord,
    source,
    local,
    priorManagement: { use: "absent", binding: "absent", base: "unknown" },
  };
}

export function parseSkillUnboundResolutionDetails(value: unknown): SkillUnboundResolutionDetails {
  const input = record(value, "Unbound skill resolution details");
  assertKeys(
    input,
    ["choice", "skillId", "source", "location", "bindingId", "status"],
    "Unbound skill resolution details",
  );
  const status = ["applied", "restored", "failed", "unknown"] as const;
  if (
    input.choice !== "link-canonical" ||
    typeof input.skillId !== "string" ||
    !UUID.test(input.skillId) ||
    typeof input.bindingId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.bindingId) ||
    !status.includes(input.status as (typeof status)[number])
  ) {
    throw new Error("Unbound skill resolution details are invalid.");
  }
  return {
    choice: "link-canonical",
    skillId: input.skillId,
    source: parseSourceSkillRef(input.source),
    location: parseSkillLocationKey(input.location),
    bindingId: input.bindingId,
    status: input.status as SkillUnboundResolutionDetails["status"],
  };
}

function parseBindingEffects(value: unknown): SkillBindingEffect[] {
  if (!Array.isArray(value)) throw new Error("Unbound resolution Binding effects are required.");
  return value.map((raw) => {
    const input = record(raw, "Unbound resolution Binding effect");
    assertKeys(input, ["bindingId", "before", "after"], "Unbound resolution Binding effect");
    if (input.before === undefined && input.after === undefined)
      throw new Error("Unbound resolution Binding effect is empty.");
    const before = input.before === undefined ? undefined : parseBinding(input.before);
    const after = input.after === undefined ? undefined : parseBinding(input.after);
    const bindingId = input.bindingId;
    if (
      typeof bindingId !== "string" ||
      (before && before.bindingId !== bindingId) ||
      (after && after.bindingId !== bindingId)
    )
      throw new Error("Unbound resolution Binding effect identity is inconsistent.");
    return { bindingId, ...(before ? { before } : {}), ...(after ? { after } : {}) };
  });
}

function sameRevision(left: SkillRevision, right: SkillRevision): boolean {
  return left.algorithm === right.algorithm && left.hash === right.hash && same(left.files, right.files);
}

function assertScopedFileActions(
  evidence: SkillUnboundResolutionEvidence,
  files: readonly SkillFileSummary[],
  actions: readonly OperationAction[],
): void {
  const location = evidence.local.location;
  const changes = new Map(files.map((file) => [file.relativePath, file]));
  if (
    changes.size !== files.length ||
    files.some((file) => file.rootId !== location.projectId || !file.relativePath.startsWith(`${location.folderPath}/`))
  ) {
    throw new Error("Unbound resolution files must stay under the one exact selected project folder.");
  }
  const fileActions = actions.filter((action) => action.kind === "write-file" || action.kind === "delete-file");
  if (fileActions.length !== files.length)
    throw new Error("Unbound resolution actions do not match its reviewed files.");
  for (const action of fileActions) {
    const file = changes.get(action.relativePath);
    if (!file || (action.kind === "delete-file") !== (file.change === "delete"))
      throw new Error("Unbound resolution action does not match its exact before/after file effect.");
    if (action.beforeHash !== file.beforeHash)
      throw new Error("Unbound resolution action omits its reviewed local before hash.");
    if (action.afterHash !== file.afterHash)
      throw new Error("Unbound resolution action omits its selected-source after hash.");
  }
}

export function parseSkillUnboundResolutionStepMetadata(
  value: RecordValue,
  scope: SkillScope,
  files: readonly SkillFileSummary[],
  actions: readonly OperationAction[],
  planKind: OperationKind,
  bindingEffectsValue: readonly SkillBindingEffect[],
): SkillUnboundResolutionStepMetadata | undefined {
  if (value.unboundResolutionEvidence === undefined) {
    if (planKind === "link-skill") throw new Error("Link operations require complete unbound resolution evidence.");
    return undefined;
  }
  if (
    (planKind !== "link-skill" && planKind !== "restore-apply") ||
    value.adoptionEvidence !== undefined ||
    value.resolutionEvidence !== undefined ||
    value.variantCaptureEvidence !== undefined
  ) {
    throw new Error("Unbound resolution evidence is exclusive to its link or inverse operation.");
  }
  const evidence = parseSkillUnboundResolutionEvidence(value.unboundResolutionEvidence);
  const restoring = planKind === "restore-apply";
  const restoreOrigin = restoring
    ? parseSkillUnboundResolutionRestoreOrigin(value.unboundResolutionRestoreOrigin)
    : undefined;
  if (!restoring && value.unboundResolutionRestoreOrigin !== undefined)
    throw new Error("Forward unbound resolution cannot contain restore-origin evidence.");
  const target = scope.targets.length === 1 ? scope.targets[0] : undefined;
  const location = evidence.local.location;
  if (
    !target ||
    target.projectId !== location.projectId ||
    target.harnessId !== location.harnessId ||
    scope.sourceId !== evidence.source.ref.sourceId ||
    scope.packageId !== evidence.source.ref.packageId ||
    scope.artifactPath !== evidence.source.ref.artifactPath
  ) {
    throw new Error("Unbound resolution scope must match its exact source and project target.");
  }
  if (!Array.isArray(value.metadataEffects) || !Array.isArray(value.baseReferences))
    throw new Error("Unbound resolution metadata and base references are required.");
  const metadataEffects = value.metadataEffects.map(parseSkillUseEffect);
  const baseReferences = value.baseReferences.map(parseSkillAdoptionBaseReference);
  const bindingEffects = parseBindingEffects(bindingEffectsValue);
  const envelope = parseSkillUnboundResolutionEnvelope(value.unboundResolutionEnvelope);
  if (
    baseReferences.length !== 1 ||
    (!restoring && (metadataEffects.length !== 1 || bindingEffects.length !== 1)) ||
    (restoring && (metadataEffects.length > 1 || bindingEffects.length > 1))
  )
    throw new Error("Unbound resolution requires one selected-source base and bounded exact management effects.");
  const [useEffect] = metadataEffects;
  const [bindingEffect] = bindingEffects;
  const [base] = baseReferences;
  if (
    !base ||
    !sameRevision(base.revision, evidence.source.revision) ||
    (!restoring &&
      (!useEffect ||
        !bindingEffect ||
        useEffect.skillId !== evidence.skillId ||
        locationKey(useEffect.location) !== locationKey(location) ||
        base.baseRevisionId !== (useEffect.after ?? useEffect.before)?.baseRevisionId)) ||
    (restoring &&
      metadataEffects.some(
        (effect) =>
          effect.skillId !== evidence.skillId ||
          locationKey(effect.location) !== locationKey(location) ||
          effect.after !== undefined,
      )) ||
    (restoring && bindingEffects.some((effect) => effect.after !== undefined))
  ) {
    throw new Error("Unbound resolution evidence does not match its exact new management records and source base.");
  }
  const use = restoring ? useEffect?.before : useEffect?.after;
  const binding = restoring ? bindingEffect?.before : bindingEffect?.after;
  if (
    (!restoring && (!use || !binding)) ||
    (use &&
      (use.skillId !== evidence.skillId ||
        locationKey(use.location) !== locationKey(location) ||
        sourceKey(use.source) !== sourceKey(evidence.source.ref) ||
        use.baseRevisionId !== base.baseRevisionId)) ||
    (binding &&
      (binding.projectId !== location.projectId ||
        binding.harnessId !== location.harnessId ||
        binding.kind !== "skill" ||
        binding.sourceId !== evidence.source.ref.sourceId ||
        binding.packageId !== evidence.source.ref.packageId ||
        binding.boundHash !== evidence.source.revision.hash ||
        binding.ownedHash !== evidence.source.revision.hash ||
        bindingFolder(binding) !== location.folderPath)) ||
    (use && binding && use.bindingId !== binding.bindingId)
  ) {
    throw new Error("Unbound resolution use and Binding do not describe the exact selected source and location.");
  }
  if (restoring) {
    if (useEffect?.after !== undefined || bindingEffect?.after !== undefined)
      throw new Error("Unbound resolution inverse must remove only its operation-created use and Binding.");
  } else if (useEffect.before !== undefined || bindingEffect.before !== undefined) {
    throw new Error("Unbound resolution forward effects require exact absent before records.");
  }
  assertScopedFileActions(evidence, files, actions);
  const directoryActions = actions.filter(
    (action) => action.kind === "create-directory" || action.kind === "delete-directory",
  );
  if (
    directoryActions.some(
      (action) =>
        action.kind !== (restoring ? "delete-directory" : "create-directory") ||
        !action.relativePath.startsWith(`${location.folderPath}/`) ||
        action.relativePath.split("/").some((part) => part === ".git" || part === ".." || part === "."),
    )
  )
    throw new Error("Unbound resolution directory effects must stay under the selected folder and preserve .git.");
  return {
    metadataEffects,
    baseReferences,
    bindingEffects,
    unboundResolutionEvidence: evidence,
    unboundResolutionEnvelope: envelope,
    ...(restoreOrigin ? { unboundResolutionRestoreOrigin: restoreOrigin } : {}),
  };
}

function bindingFolder(binding: Binding): string | undefined {
  const artifact = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const key = artifact.split("/").at(-1);
  if (!key) return undefined;
  const root = binding.harnessId === "codex" ? ".agents" : binding.harnessId === "claude-code" ? ".claude" : ".cursor";
  return `${root}/skills/${key}`;
}
