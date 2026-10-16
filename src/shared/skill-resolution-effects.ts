import { parseBinding } from "./bindings-ipc";
import {
  parseManagedSkillUse,
  parseSkillLocationKey,
  parseSkillRevision,
  parseSourceSkillRef,
} from "../domain/skill-reconciliation/validation";
import type { Binding } from "../domain/assignment-plan";
import type {
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SkillUseEffect,
  SourceSkillRef,
} from "../domain/skill-reconciliation/types";
import type { SkillScope } from "./skill-management-ipc";
import {
  parseSkillUseEffect,
  parseSkillAdoptionBaseReference,
  type SkillAdoptionBaseReference,
} from "./skill-adoption-effects";
import type { OperationAction, OperationKind } from "./operations-ipc";
import type { SkillBindingEffect, SkillFileSummary } from "./skill-management-ipc";

export type SkillResolutionEvidence = Readonly<{
  choice: "keep-local" | "use-canonical";
  skillId: string;
  storeRevision: number;
  source: SourceSkillRef;
  sourceTree?: Readonly<{ rootIdentity: string; revision: SkillRevision }>;
  local: Readonly<{ location: SkillLocationKey; rootIdentity: string; revision: SkillRevision }>;
  use: ManagedSkillUse;
  binding: Binding;
  base: Readonly<{ baseRevisionId: string; revision: SkillRevision }>;
}>;

export type SkillManagedResolutionDetails = Readonly<{
  skillId: string;
  choice: "keep-local" | "use-canonical";
  targets: readonly [
    Readonly<{
      location: SkillLocationKey;
      bindingId: string;
      status: "applied" | "no-op" | "retained-local" | "restored" | "failed" | "unknown";
    }>,
  ];
}>;

export type SkillResolutionStepMetadata = Readonly<{
  metadataEffects: readonly SkillUseEffect[];
  baseReferences: readonly SkillAdoptionBaseReference[];
  resolutionEvidence: SkillResolutionEvidence;
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

function locationIdentity(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sourceIdentity(source: SourceSkillRef): string {
  return JSON.stringify([source.sourceId, source.packageId, source.artifactPath]);
}

function rootIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function parseBase(value: unknown): SkillAdoptionBaseReference {
  return parseSkillAdoptionBaseReference(value);
}

export function parseSkillResolutionEvidence(value: unknown): SkillResolutionEvidence {
  const input = record(value, "Skill resolution evidence");
  assertKeys(
    input,
    ["choice", "skillId", "storeRevision", "source", "sourceTree", "local", "use", "binding", "base"],
    "Skill resolution evidence",
  );
  if (
    (input.choice !== "keep-local" && input.choice !== "use-canonical") ||
    typeof input.skillId !== "string" ||
    !UUID.test(input.skillId)
  ) {
    throw new Error("Skill resolution choice or skill id is invalid.");
  }
  if (!Number.isSafeInteger(input.storeRevision) || Number(input.storeRevision) < 0) {
    throw new Error("Skill resolution store revision is invalid.");
  }
  const source = parseSourceSkillRef(input.source);
  const sourceTree =
    input.sourceTree === undefined
      ? undefined
      : (() => {
          const tree = record(input.sourceTree, "Skill resolution source tree");
          assertKeys(tree, ["rootIdentity", "revision"], "Skill resolution source tree");
          return {
            rootIdentity: rootIdentity(tree.rootIdentity, "Source root identity"),
            revision: parseSkillRevision(tree.revision),
          };
        })();
  const localInput = record(input.local, "Skill resolution local tree");
  assertKeys(localInput, ["location", "rootIdentity", "revision"], "Skill resolution local tree");
  const local = {
    location: parseSkillLocationKey(localInput.location),
    rootIdentity: rootIdentity(localInput.rootIdentity, "Project root identity"),
    revision: parseSkillRevision(localInput.revision),
  };
  const use = parseManagedSkillUse(input.use);
  const binding = parseBinding(input.binding);
  const baseInput = record(input.base, "Skill resolution base");
  assertKeys(baseInput, ["baseRevisionId", "revision"], "Skill resolution base");
  if (typeof baseInput.baseRevisionId !== "string" || !UUID.test(baseInput.baseRevisionId)) {
    throw new Error("Skill resolution base id is invalid.");
  }
  const base = { baseRevisionId: baseInput.baseRevisionId, revision: parseSkillRevision(baseInput.revision) };
  const bindingSourcePath = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  if (
    use.skillId !== input.skillId ||
    locationIdentity(use.location) !== locationIdentity(local.location) ||
    sourceIdentity(use.source) !== sourceIdentity(source) ||
    use.baseRevisionId !== base.baseRevisionId ||
    binding.bindingId !== use.bindingId ||
    binding.kind !== "skill" ||
    binding.projectId !== use.location.projectId ||
    binding.harnessId !== use.location.harnessId ||
    binding.sourceId !== source.sourceId ||
    binding.packageId !== source.packageId ||
    bindingSourcePath !== source.artifactPath
  ) {
    throw new Error("Skill resolution evidence does not describe one exact managed use and binding.");
  }
  if (input.choice === "use-canonical" && sourceTree === undefined) {
    throw new Error("Canonical resolution requires a complete owned source tree.");
  }
  return {
    choice: input.choice,
    skillId: input.skillId,
    storeRevision: Number(input.storeRevision),
    source,
    ...(sourceTree ? { sourceTree } : {}),
    local,
    use,
    binding,
    base,
  };
}

export function parseSkillManagedResolutionDetails(value: unknown): SkillManagedResolutionDetails {
  const input = record(value, "Managed skill resolution details");
  assertKeys(input, ["skillId", "choice", "targets"], "Managed skill resolution details");
  if (
    typeof input.skillId !== "string" ||
    !UUID.test(input.skillId) ||
    (input.choice !== "keep-local" && input.choice !== "use-canonical") ||
    !Array.isArray(input.targets) ||
    input.targets.length !== 1
  ) {
    throw new Error("Managed skill resolution details are invalid.");
  }
  const target = record(input.targets[0], "Managed skill resolution target");
  assertKeys(target, ["location", "bindingId", "status"], "Managed skill resolution target");
  const statuses = ["applied", "no-op", "retained-local", "restored", "failed", "unknown"] as const;
  if (
    typeof target.bindingId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(target.bindingId) ||
    !statuses.includes(target.status as (typeof statuses)[number])
  ) {
    throw new Error("Managed skill resolution target is invalid.");
  }
  return {
    skillId: input.skillId,
    choice: input.choice,
    targets: [
      {
        location: parseSkillLocationKey(target.location),
        bindingId: target.bindingId,
        status: target.status as SkillManagedResolutionDetails["targets"][number]["status"],
      },
    ],
  };
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseSkillResolutionStepMetadata(
  value: RecordValue,
  scope: SkillScope,
  files: readonly SkillFileSummary[],
  actions: readonly OperationAction[],
  planKind: OperationKind,
  bindingEffects: readonly SkillBindingEffect[],
): SkillResolutionStepMetadata | undefined {
  if (value.resolutionEvidence === undefined) {
    if (planKind === "resolve-skill") throw new Error("Resolution operations require complete resolution evidence.");
    return undefined;
  }
  if (value.adoptionEvidence !== undefined || (planKind !== "resolve-skill" && planKind !== "restore-apply")) {
    throw new Error("Managed resolution evidence is exclusive to resolve-skill operations.");
  }
  const restoring = planKind === "restore-apply";
  const evidence = parseSkillResolutionEvidence(value.resolutionEvidence);
  if (!Array.isArray(value.baseReferences)) throw new Error("Managed resolution base references are required.");
  const baseReferences = value.baseReferences.map(parseBase);
  const metadataEffects =
    value.metadataEffects === undefined
      ? []
      : (() => {
          if (!Array.isArray(value.metadataEffects)) throw new Error("Managed resolution use effects are invalid.");
          return value.metadataEffects.map(parseSkillUseEffect);
        })();
  if (baseReferences.length < 1 || baseReferences.length > 2)
    throw new Error("Managed resolution base references are incomplete.");
  const byBaseId = new Map<string, SkillRevision>();
  for (const base of baseReferences) {
    if (byBaseId.has(base.baseRevisionId)) throw new Error("Managed resolution base references must be unique.");
    byBaseId.set(base.baseRevisionId, base.revision);
  }
  if (
    byBaseId.get(evidence.base.baseRevisionId) === undefined ||
    !sameRecord(byBaseId.get(evidence.base.baseRevisionId), evidence.base.revision)
  ) {
    throw new Error("Managed resolution evidence omits its verified before base.");
  }
  const target = scope.targets.length === 1 ? scope.targets[0] : undefined;
  if (
    !target ||
    target.projectId !== evidence.local.location.projectId ||
    target.harnessId !== evidence.local.location.harnessId ||
    target.bindingId !== evidence.binding.bindingId ||
    scope.sourceId !== evidence.source.sourceId ||
    scope.packageId !== evidence.source.packageId ||
    scope.artifactPath !== evidence.source.artifactPath
  ) {
    throw new Error("Managed resolution scope does not match its selected use and source.");
  }
  if (restoring) {
    if (evidence.choice !== "use-canonical" || !evidence.sourceTree)
      throw new Error("Only canonical replacements have a managed resolution restore.");
    const canonicalBaseIds = baseReferences
      .filter((base) => sameRecord(base.revision, evidence.sourceTree!.revision))
      .map((base) => base.baseRevisionId);
    if (canonicalBaseIds.length !== 1)
      throw new Error("Managed resolution restore requires its exact canonical base reference.");
    const canonicalBaseId = canonicalBaseIds[0]!;
    const forwardUse: ManagedSkillUse = { ...evidence.use, baseRevisionId: canonicalBaseId };
    const useChanged = !sameRecord(forwardUse, evidence.use);
    if (
      metadataEffects.length !== (useChanged ? 1 : 0) ||
      metadataEffects.some(
        (effect) =>
          effect.skillId !== evidence.skillId ||
          locationIdentity(effect.location) !== locationIdentity(evidence.local.location) ||
          !sameRecord(effect.before, forwardUse) ||
          !sameRecord(effect.after, evidence.use),
      )
    ) {
      throw new Error("Managed resolution restore use effects do not exactly reverse the reviewed transition.");
    }
    const forwardBinding: Binding = {
      ...evidence.binding,
      boundHash: evidence.sourceTree.revision.hash,
      ownedHash: evidence.sourceTree.revision.hash,
    };
    const bindingChanged = !sameRecord(forwardBinding, evidence.binding);
    if (
      bindingEffects.length !== (bindingChanged ? 1 : 0) ||
      bindingEffects.some(
        (effect) =>
          effect.bindingId !== evidence.binding.bindingId ||
          !sameRecord(effect.before, forwardBinding) ||
          !sameRecord(effect.after, evidence.binding),
      )
    ) {
      throw new Error("Managed resolution restore Binding effects do not exactly reverse the reviewed transition.");
    }
  } else if (
    metadataEffects.length > 1 ||
    metadataEffects.some(
      (effect) =>
        effect.skillId !== evidence.skillId ||
        locationIdentity(effect.location) !== locationIdentity(evidence.local.location) ||
        !sameRecord(effect.before, evidence.use) ||
        !effect.after ||
        effect.after.skillId !== evidence.skillId ||
        effect.after.bindingId !== evidence.use.bindingId ||
        locationIdentity(effect.after.location) !== locationIdentity(evidence.local.location) ||
        sourceIdentity(effect.after.source) !== sourceIdentity(evidence.source) ||
        byBaseId.get(effect.after.baseRevisionId) === undefined ||
        !sameRecord(byBaseId.get(effect.after.baseRevisionId), evidence.sourceTree?.revision ?? evidence.base.revision),
    )
  ) {
    throw new Error("Managed resolution use effects exceed their verified before and after states.");
  }
  if (
    evidence.choice === "keep-local" &&
    (files.length || actions.length || bindingEffects.length || metadataEffects.length)
  ) {
    throw new Error("Keep local is a record-only decision without file or management changes.");
  }
  if (!restoring && evidence.choice === "use-canonical" && metadataEffects.length && bindingEffects.length > 1) {
    throw new Error("Canonical resolution may update only the selected binding.");
  }
  if (
    !restoring &&
    evidence.choice === "use-canonical" &&
    bindingEffects.some(
      (effect) =>
        !sameRecord(effect.before, evidence.binding) ||
        effect.bindingId !== evidence.binding.bindingId ||
        !effect.after ||
        effect.after.bindingId !== evidence.binding.bindingId ||
        effect.after.projectId !== evidence.local.location.projectId ||
        effect.after.harnessId !== evidence.local.location.harnessId ||
        effect.after.sourceId !== evidence.source.sourceId ||
        effect.after.packageId !== evidence.source.packageId ||
        effect.after.boundHash !== evidence.sourceTree?.revision.hash ||
        effect.after.ownedHash !== evidence.sourceTree?.revision.hash,
    )
  ) {
    throw new Error("Canonical resolution binding effects do not preserve the approved selected assignment.");
  }
  if (!restoring && evidence.choice === "use-canonical") {
    const hashesAlreadyMatch =
      evidence.binding.boundHash === evidence.sourceTree!.revision.hash &&
      evidence.binding.ownedHash === evidence.sourceTree!.revision.hash;
    if (bindingEffects.length !== (hashesAlreadyMatch ? 0 : 1)) {
      throw new Error("Canonical resolution must account for the selected binding hash transition.");
    }
  }
  const folderPrefix = `${evidence.local.location.folderPath}/`;
  if (
    files.some(
      (file) => file.rootId !== evidence.local.location.projectId || !file.relativePath.startsWith(folderPrefix),
    ) ||
    actions.some((action) => !action.relativePath.startsWith(folderPrefix))
  ) {
    throw new Error("Managed resolution file effects must stay inside the selected project folder.");
  }
  const actionFiles = actions.filter((action) => action.kind === "write-file" || action.kind === "delete-file");
  if (
    actionFiles.length !== files.length ||
    actionFiles.some((action) => !files.some((file) => file.relativePath === action.relativePath))
  ) {
    throw new Error("Managed resolution summaries must match the complete selected file effects.");
  }
  if (evidence.choice === "use-canonical") {
    const forwardBefore = new Map(evidence.local.revision.files.map((file) => [file.path, file]));
    const forwardAfter = new Map(evidence.sourceTree!.revision.files.map((file) => [file.path, file]));
    const before = restoring ? forwardAfter : forwardBefore;
    const after = restoring ? forwardBefore : forwardAfter;
    const expected = [...new Set([...before.keys(), ...after.keys()])]
      .sort((left, right) => left.localeCompare(right))
      .flatMap((path) => {
        const prior = before.get(path);
        const proposed = after.get(path);
        if (prior?.hash === proposed?.hash && prior?.byteLength === proposed?.byteLength) return [];
        return [
          {
            relativePath: `${evidence.local.location.folderPath}/${path}`,
            change: prior === undefined ? "add" : proposed === undefined ? "delete" : "change",
            byteLength: proposed?.byteLength ?? prior?.byteLength,
            ...(prior ? { beforeHash: prior.hash } : {}),
            ...(proposed ? { afterHash: proposed.hash } : {}),
          },
        ];
      });
    const actual = files.map(({ relativePath, change, byteLength, beforeHash, afterHash }) => ({
      relativePath,
      change,
      byteLength,
      beforeHash,
      afterHash,
    }));
    if (!sameRecord(actual, expected))
      throw new Error("Managed resolution file summaries do not match the complete captured trees.");
    for (const action of actionFiles) {
      const file = files.find((candidate) => candidate.relativePath === action.relativePath)!;
      const kind = file.change === "delete" ? "delete-file" : "write-file";
      if (action.kind !== kind || action.beforeHash !== file.beforeHash || action.afterHash !== file.afterHash) {
        throw new Error("Managed resolution file actions do not match their reviewed byte summaries.");
      }
    }
  }
  if (!restoring && evidence.choice === "use-canonical" && evidence.sourceTree) {
    const afterUse = metadataEffects[0]?.after;
    const afterBaseId = afterUse?.baseRevisionId ?? evidence.base.baseRevisionId;
    if (
      byBaseId.get(afterBaseId) === undefined ||
      !sameRecord(byBaseId.get(afterBaseId), evidence.sourceTree.revision)
    ) {
      throw new Error("Managed resolution omits its verified canonical base revision.");
    }
  }
  return { metadataEffects, baseReferences, resolutionEvidence: evidence };
}
