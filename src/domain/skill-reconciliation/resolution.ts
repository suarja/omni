import { createHash } from "node:crypto";

import type { Binding } from "../assignment-plan";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SkillUseEffect,
  SourceSkillRef,
} from "./types";
import type { SkillFileSummary, SkillBindingEffect } from "../../shared/skill-management-ipc";
import type { SkillAdoptionBaseReference } from "../../shared/skill-adoption-effects";
import type { SkillResolutionEvidence } from "../../shared/skill-resolution-effects";
import type { SkillManagedResolutionRequest } from "../../shared/skill-reconciliation-request";

type CapturedTree = Readonly<{ rootIdentity: string; revision: SkillRevision }>;

export type ManagedSkillResolutionInput = Readonly<{
  request: SkillManagedResolutionRequest;
  record: LogicalSkillRecord | undefined;
  storeRevision: number;
  use: ManagedSkillUse | undefined;
  binding: Binding | undefined;
  local: CapturedTree | undefined;
  base: Readonly<{ baseRevisionId: string; revision: SkillRevision }> | undefined;
  sourceTree?: Readonly<{ ref: SourceSkillRef; rootIdentity: string; revision: SkillRevision }>;
  intentId: string;
}>;

export type ManagedSkillResolutionPlan =
  | Readonly<{
      status: "ready";
      choice: SkillManagedResolutionRequest["choice"];
      noOp: boolean;
      evidence: SkillResolutionEvidence;
      files: readonly SkillFileSummary[];
      bindingEffects: readonly SkillBindingEffect[];
      metadataEffects: readonly SkillUseEffect[];
      baseReferences: readonly SkillAdoptionBaseReference[];
    }>
  | Readonly<{ status: "blocked" | "needs-input"; code: string; reason: string }>;

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sourceKey(source: SourceSkillRef): string {
  return JSON.stringify([source.sourceId, source.packageId, source.artifactPath]);
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRevision(left: SkillRevision, right: SkillRevision): boolean {
  if (left.algorithm !== right.algorithm || left.hash !== right.hash || left.files.length !== right.files.length)
    return false;
  const leftFiles = [...left.files].sort((a, b) => a.path.localeCompare(b.path));
  const rightFiles = [...right.files].sort((a, b) => a.path.localeCompare(b.path));
  return leftFiles.every((file, index) => {
    const candidate = rightFiles[index];
    return file.path === candidate?.path && file.hash === candidate.hash && file.byteLength === candidate.byteLength;
  });
}

function deterministicBaseId(intentId: string, skillId: string, hash: string): string {
  const value = createHash("sha256")
    .update(`${intentId}\n${skillId}\n${hash}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16]!, 16) & 3) | 8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function blocked(code: string, reason: string): ManagedSkillResolutionPlan {
  return { status: "blocked", code, reason };
}

function needsInput(code: string, reason: string): ManagedSkillResolutionPlan {
  return { status: "needs-input", code, reason };
}

function filesBetween(location: SkillLocationKey, local: SkillRevision, source: SkillRevision): SkillFileSummary[] {
  const before = new Map(local.files.map((file) => [file.path, file]));
  const after = new Map(source.files.map((file) => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right));
  return paths.flatMap((path) => {
    const previous = before.get(path);
    const proposed = after.get(path);
    if (previous?.hash === proposed?.hash && previous?.byteLength === proposed?.byteLength) return [];
    return [
      {
        rootId: location.projectId,
        relativePath: `${location.folderPath}/${path}`,
        change: previous === undefined ? "add" : proposed === undefined ? "delete" : "change",
        byteLength: proposed?.byteLength ?? previous?.byteLength,
        ...(previous ? { beforeHash: previous.hash } : {}),
        ...(proposed ? { afterHash: proposed.hash } : {}),
      },
    ];
  });
}

function bindingSourcePath(binding: Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  return binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
}

export function planManagedSkillResolution(input: ManagedSkillResolutionInput): ManagedSkillResolutionPlan {
  const { request } = input;
  const [location] = request.locations;
  const key = locationKey(location);
  if (
    !input.record ||
    input.record.skillId !== request.skillId ||
    !input.record.locations.some((item) => locationKey(item) === key)
  ) {
    return blocked("location-not-in-skill", "The selected location no longer belongs to this logical skill.");
  }
  if (!input.use || input.use.skillId !== request.skillId || locationKey(input.use.location) !== key) {
    return blocked("managed-use-unavailable", "The selected location has no verified managed skill use.");
  }
  if (
    !input.binding ||
    input.binding.bindingId !== input.use.bindingId ||
    input.binding.projectId !== location.projectId ||
    input.binding.harnessId !== location.harnessId ||
    input.binding.sourceId !== input.use.source.sourceId ||
    input.binding.packageId !== input.use.source.packageId ||
    bindingSourcePath(input.binding) !== input.use.source.artifactPath
  ) {
    return blocked("use-binding-mismatch", "The saved managed use and exact current binding do not agree.");
  }
  if (!input.base || input.base.baseRevisionId !== input.use.baseRevisionId) {
    return needsInput("base-unavailable", "The selected managed use has no verified immutable base.");
  }
  if (!input.local) return needsInput("local-unavailable", "The selected managed folder could not be read completely.");
  if (request.choice === "use-canonical" && !input.sourceTree) {
    return needsInput(
      "source-unavailable",
      "The approved owned source is not currently available for a complete review.",
    );
  }
  if (input.sourceTree && sourceKey(input.sourceTree.ref) !== sourceKey(input.use.source)) {
    return blocked("source-mismatch", "The captured source is not the source already approved for this managed use.");
  }

  const evidence: SkillResolutionEvidence = {
    choice: request.choice,
    skillId: request.skillId,
    storeRevision: input.storeRevision,
    source: input.use.source,
    ...(input.sourceTree
      ? { sourceTree: { rootIdentity: input.sourceTree.rootIdentity, revision: input.sourceTree.revision } }
      : {}),
    local: { location, rootIdentity: input.local.rootIdentity, revision: input.local.revision },
    use: input.use,
    binding: input.binding,
    base: input.base,
  };
  if (request.choice === "keep-local") {
    return {
      status: "ready",
      choice: request.choice,
      noOp: false,
      evidence,
      files: [],
      bindingEffects: [],
      metadataEffects: [],
      baseReferences: [{ baseRevisionId: input.base.baseRevisionId, revision: input.base.revision }],
    };
  }

  const source = input.sourceTree!;
  const proposedBaseId = sameRevision(input.base.revision, source.revision)
    ? input.base.baseRevisionId
    : deterministicBaseId(input.intentId, request.skillId, source.revision.hash);
  const afterUse: ManagedSkillUse = { ...input.use, baseRevisionId: proposedBaseId };
  const afterBinding: Binding = {
    ...input.binding,
    boundHash: source.revision.hash,
    ownedHash: source.revision.hash,
  };
  const bindingChanged = !sameRecord(input.binding, afterBinding);
  const useChanged = !sameRecord(input.use, afterUse);
  const bindingEffects = bindingChanged
    ? [{ bindingId: input.binding.bindingId, before: input.binding, after: afterBinding }]
    : [];
  const metadataEffects = useChanged
    ? [{ skillId: request.skillId, location, before: input.use, after: afterUse }]
    : [];
  const fileEffects = filesBetween(location, input.local.revision, source.revision);
  const baseReferences = [
    { baseRevisionId: input.base.baseRevisionId, revision: input.base.revision },
    ...(proposedBaseId === input.base.baseRevisionId
      ? []
      : [{ baseRevisionId: proposedBaseId, revision: source.revision }]),
  ];
  return {
    status: "ready",
    choice: request.choice,
    noOp: fileEffects.length === 0 && bindingEffects.length === 0 && metadataEffects.length === 0,
    evidence,
    files: fileEffects,
    bindingEffects,
    metadataEffects,
    baseReferences,
  };
}
