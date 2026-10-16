import { parseBinding } from "./bindings-ipc";
import {
  parseLogicalSkillRecord,
  parseManagedSkillUse,
  parseSkillLocationKey,
  parseSkillRevision,
  parseSourceSkillRef,
} from "../domain/skill-reconciliation/validation";
import type { Binding } from "../domain/assignment-plan";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
  SkillUseEffect,
} from "../domain/skill-reconciliation/types";
import type { SkillScope } from "./skill-management-ipc";
import { parseSkillDetachmentRequest, type SkillDetachmentRequest } from "./skill-detachment-request";
import type { SkillDirectoryEnvelope } from "./skill-directory-envelope";

export type SkillDetachmentEvidence = Readonly<{
  choice: "detach-managed";
  skillId: string;
  storeRevision: number;
  record: LogicalSkillRecord;
  local: Readonly<{
    location: SkillLocationKey;
    rootIdentity: string;
    revision: SkillRevision;
    envelope: SkillDirectoryEnvelope;
  }>;
  use: ManagedSkillUse;
  binding: Binding;
  base: Readonly<{ baseRevisionId: string; revision: SkillRevision }>;
}>;

export type SkillDetachmentDetails = Readonly<{
  choice: "detach-managed";
  skillId: string;
  location: SkillLocationKey;
  source: SourceSkillRef;
  bindingId: string;
  status: "detached" | "restored" | "unchanged" | "failed" | "unknown";
}>;

export type SkillDetachmentRestoreOrigin = Readonly<{ intentId: string; stepId: string }>;
export type SkillDetachmentStepMetadata = Readonly<{
  detachmentEvidence: SkillDetachmentEvidence;
  metadataEffects: readonly SkillUseEffect[];
  detachmentRestoreOrigin?: SkillDetachmentRestoreOrigin;
}>;

type RecordValue = Record<string, unknown>;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseEnvelope(value: unknown): SkillDirectoryEnvelope {
  if (!Array.isArray(value)) throw new Error("Skill directory envelope must be an array.");
  const envelope: SkillDirectoryEnvelope = value.map((item) => {
    const entry = record(item, "Skill directory envelope entry");
    keys(entry, ["path", "kind", "identity"], "Skill directory envelope entry");
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      (entry.path !== "." &&
        (entry.path.startsWith("/") || entry.path.split("/").some((part) => !part || part === "." || part === ".."))) ||
      (entry.kind !== "file" && entry.kind !== "directory") ||
      typeof entry.identity !== "string" ||
      !entry.identity.trim() ||
      entry.identity.length > 256
    ) {
      throw new Error("Skill directory envelope entry is invalid.");
    }
    return { path: entry.path, kind: entry.kind as "file" | "directory", identity: entry.identity };
  });
  if (new Set(envelope.map(({ path }) => path)).size !== envelope.length)
    throw new Error("Skill directory envelope paths must be unique.");
  if (envelope.length && !envelope.some(({ path, kind }) => path === "." && kind === "directory"))
    throw new Error("Skill directory envelope root is missing.");
  return envelope;
}

export function parseSkillDetachmentEvidence(value: unknown): SkillDetachmentEvidence {
  const input = record(value, "Skill detachment evidence");
  keys(
    input,
    ["choice", "skillId", "storeRevision", "record", "local", "use", "binding", "base"],
    "Skill detachment evidence",
  );
  if (
    input.choice !== "detach-managed" ||
    typeof input.skillId !== "string" ||
    !UUID.test(input.skillId) ||
    !Number.isSafeInteger(input.storeRevision) ||
    Number(input.storeRevision) < 0
  ) {
    throw new Error("Skill detachment evidence metadata is invalid.");
  }
  const recordValue = parseLogicalSkillRecord(input.record);
  const localInput = record(input.local, "Skill detachment local evidence");
  keys(localInput, ["location", "rootIdentity", "revision", "envelope"], "Skill detachment local evidence");
  if (typeof localInput.rootIdentity !== "string" || !HASH.test(localInput.rootIdentity))
    throw new Error("Skill detachment project root identity is invalid.");
  const local = {
    location: parseSkillLocationKey(localInput.location),
    rootIdentity: localInput.rootIdentity,
    revision: parseSkillRevision(localInput.revision),
    envelope: parseEnvelope(localInput.envelope),
  };
  const use = parseManagedSkillUse(input.use);
  const binding = parseBinding(input.binding);
  const baseInput = record(input.base, "Skill detachment base evidence");
  keys(baseInput, ["baseRevisionId", "revision"], "Skill detachment base evidence");
  if (typeof baseInput.baseRevisionId !== "string" || !UUID.test(baseInput.baseRevisionId))
    throw new Error("Skill detachment base revision id is invalid.");
  const base = { baseRevisionId: baseInput.baseRevisionId, revision: parseSkillRevision(baseInput.revision) };
  if (
    recordValue.skillId !== input.skillId ||
    !recordValue.locations.some((location) => locationKey(location) === locationKey(local.location)) ||
    use.skillId !== input.skillId ||
    locationKey(use.location) !== locationKey(local.location) ||
    binding.bindingId !== use.bindingId ||
    base.baseRevisionId !== use.baseRevisionId
  ) {
    throw new Error("Skill detachment evidence does not describe one exact managed copy.");
  }
  return {
    choice: "detach-managed",
    skillId: input.skillId,
    storeRevision: Number(input.storeRevision),
    record: recordValue,
    local,
    use,
    binding,
    base,
  };
}

export function parseSkillDetachmentDetails(value: unknown): SkillDetachmentDetails {
  const input = record(value, "Skill detachment details");
  keys(input, ["choice", "skillId", "location", "source", "bindingId", "status"], "Skill detachment details");
  const statuses = ["detached", "restored", "unchanged", "failed", "unknown"] as const;
  if (
    input.choice !== "detach-managed" ||
    typeof input.skillId !== "string" ||
    !UUID.test(input.skillId) ||
    typeof input.bindingId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.bindingId) ||
    !statuses.includes(input.status as (typeof statuses)[number])
  ) {
    throw new Error("Skill detachment details are invalid.");
  }
  return {
    choice: "detach-managed",
    skillId: input.skillId,
    location: parseSkillLocationKey(input.location),
    source: parseSourceSkillRef(input.source),
    bindingId: input.bindingId,
    status: input.status as SkillDetachmentDetails["status"],
  };
}

export function parseSkillDetachmentRestoreOrigin(value: unknown): SkillDetachmentRestoreOrigin {
  const input = record(value, "Skill detachment restore origin");
  keys(input, ["intentId", "stepId"], "Skill detachment restore origin");
  for (const key of ["intentId", "stepId"] as const) {
    if (typeof input[key] !== "string" || !input[key] || input[key].length > 128)
      throw new Error(`Skill detachment ${key} is invalid.`);
  }
  return { intentId: input.intentId as string, stepId: input.stepId as string };
}

export function parseSkillDetachmentReceiptPointer(value: unknown): SkillDetachmentRestoreOrigin {
  return parseSkillDetachmentRestoreOrigin(value);
}

export function parseSkillDetachmentStepMetadata(
  value: RecordValue,
  scope: SkillScope,
  fileCount: number,
  actionCount: number,
  planKind: string,
  bindingEffects: readonly Readonly<{ bindingId: string; before?: Binding; after?: Binding }>[],
): SkillDetachmentStepMetadata | undefined {
  const present = value.detachmentEvidence !== undefined || value.detachmentRestoreOrigin !== undefined;
  if (!present) return undefined;
  if (
    value.detachmentEvidence === undefined ||
    fileCount > 0 ||
    actionCount > 0 ||
    planKind !== "detach-skill" ||
    value.baseReferences !== undefined ||
    value.adoptionEvidence !== undefined ||
    value.resolutionEvidence !== undefined ||
    value.variantCaptureEvidence !== undefined ||
    value.unboundResolutionEvidence !== undefined
  ) {
    throw new Error("Skill detachment effects must be metadata-only and cannot mix reconciliation evidence.");
  }
  const evidence = parseSkillDetachmentEvidence(value.detachmentEvidence);
  const origin =
    value.detachmentRestoreOrigin === undefined
      ? undefined
      : parseSkillDetachmentRestoreOrigin(value.detachmentRestoreOrigin);
  const location = evidence.local.location;
  if (
    scope.targets.length !== 1 ||
    scope.targets[0]?.projectId !== location.projectId ||
    scope.targets[0]?.harnessId !== location.harnessId ||
    scope.targets[0]?.bindingId !== evidence.binding.bindingId ||
    scope.sourceId !== evidence.use.source.sourceId ||
    scope.packageId !== evidence.use.source.packageId ||
    scope.artifactPath !== evidence.use.source.artifactPath ||
    bindingEffects.length !== 1 ||
    bindingEffects[0]?.bindingId !== evidence.binding.bindingId
  ) {
    throw new Error("Skill detachment step exceeds its verified location or source scope.");
  }
  if (!Array.isArray(value.metadataEffects) || value.metadataEffects.length !== 1)
    throw new Error("Skill detachment metadata effect is missing.");
  const metadata = record(value.metadataEffects[0], "Skill detachment metadata effect");
  keys(metadata, ["skillId", "location", "before", "after"], "Skill detachment metadata effect");
  const effectLocation = parseSkillLocationKey(metadata.location);
  if (metadata.skillId !== evidence.skillId || locationKey(effectLocation) !== locationKey(location))
    throw new Error("Skill detachment metadata does not match its selected copy.");
  const before = metadata.before === undefined ? undefined : parseManagedSkillUse(metadata.before);
  const after = metadata.after === undefined ? undefined : parseManagedSkillUse(metadata.after);
  const bindingEffect = bindingEffects[0]!;
  if (origin) {
    if (
      !(
        (bindingEffect.before === undefined && same(bindingEffect.after, evidence.binding)) ||
        (same(bindingEffect.before, evidence.binding) && same(bindingEffect.after, evidence.binding))
      ) ||
      (!(before === undefined && same(after, evidence.use)) &&
        !(same(before, evidence.use) && same(after, evidence.use)))
    ) {
      throw new Error("Skill detachment restore must add or preserve only the original Binding and managed use.");
    }
  } else if (
    !same(bindingEffect.before, evidence.binding) ||
    bindingEffect.after !== undefined ||
    !same(before, evidence.use) ||
    after !== undefined
  ) {
    throw new Error("Skill detachment must remove only the selected Binding and managed use.");
  }
  return {
    detachmentEvidence: evidence,
    metadataEffects: [
      { skillId: evidence.skillId, location, ...(before ? { before } : {}), ...(after ? { after } : {}) },
    ],
    ...(origin ? { detachmentRestoreOrigin: origin } : {}),
  };
}
