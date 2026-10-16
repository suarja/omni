import type { Binding } from "../assignment-plan";
import { resolveTarget } from "../harness-targets";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SkillUseEffect,
  SourceSkillRef,
} from "./types";
import type { SkillAdoptionRequest } from "../../shared/skill-reconciliation-request";
import type { SkillBindingEffect } from "../../shared/skill-management-ipc";

export type SkillAdoptionPlan =
  | Readonly<{
      status: "ready";
      noOp: boolean;
      baseRevisionId: string;
      bindingEffects: readonly SkillBindingEffect[];
      metadataEffects: readonly SkillUseEffect[];
    }>
  | Readonly<{ status: "blocked" | "needs-input"; code: string; reason: string }>;

export type SkillAdoptionPolicyInput = Readonly<{
  request: SkillAdoptionRequest;
  record: LogicalSkillRecord | undefined;
  sourceRevision: SkillRevision;
  locals: readonly Readonly<{ location: SkillLocationKey; revision: SkillRevision }>[];
  bindings: readonly Binding[];
  uses: readonly ManagedSkillUse[];
  baseRevisionId: string;
  now: string;
  allocateBindingId: (location: SkillLocationKey) => string;
}>;

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sourceKey(source: SourceSkillRef): string {
  return JSON.stringify([source.sourceId, source.packageId, source.artifactPath]);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
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

function skillIdForArtifact(artifactPath: string): string {
  const parts = artifactPath.split("/");
  return parts.at(-1) ?? "";
}

function expectedFolder(source: SourceSkillRef, location: SkillLocationKey): string | undefined {
  const target = resolveTarget({
    kind: "skill",
    id: skillIdForArtifact(source.artifactPath),
    harnessId: location.harnessId,
  });
  return target.status === "target" ? target.relativePath : undefined;
}

function bindingArtifactFolder(binding: Binding): string | undefined {
  if (binding.kind !== "skill" || !binding.artifactPath) return undefined;
  const path = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const id = path.split("/").at(-1);
  if (!id) return undefined;
  const resolved = resolveTarget({ kind: "skill", id, harnessId: binding.harnessId });
  return resolved.status === "target" ? resolved.relativePath : undefined;
}

function bindingMatchesSource(binding: Binding, source: SourceSkillRef): boolean {
  return (
    binding.sourceId === source.sourceId &&
    binding.packageId === source.packageId &&
    (binding.artifactPath === source.artifactPath || binding.artifactPath === `${source.artifactPath}/SKILL.md`)
  );
}

function blocked(code: string, reason: string): SkillAdoptionPlan {
  return { status: "blocked", code, reason };
}

function needsInput(code: string, reason: string): SkillAdoptionPlan {
  return { status: "needs-input", code, reason };
}

export function planSkillAdoption(input: SkillAdoptionPolicyInput): SkillAdoptionPlan {
  const { request, record, sourceRevision } = input;
  if (!record || record.skillId !== request.skillId)
    return blocked("skill-record-unavailable", "The selected logical skill record is no longer available.");
  const recordLocations = new Set(record.locations.map(locationKey));
  if (request.locations.some((location) => !recordLocations.has(locationKey(location))))
    return blocked("location-not-in-skill", "A selected copy no longer belongs to this logical skill.");

  const selectedKeys = new Set(request.locations.map(locationKey));
  const localByKey = new Map(input.locals.map((local) => [locationKey(local.location), local]));
  if (
    localByKey.size !== input.locals.length ||
    request.locations.some((location) => !localByKey.has(locationKey(location)))
  )
    return blocked("selected-copy-unavailable", "Complete evidence is unavailable for a selected copy.");
  for (const location of request.locations) {
    if (expectedFolder(request.source, location) !== location.folderPath)
      return blocked(
        "target-key-mismatch",
        "The selected location does not match the source skill's conventional target.",
      );
    if (!sameRevision(sourceRevision, localByKey.get(locationKey(location))!.revision))
      return needsInput(
        "copy-differs",
        "Every selected copy must match the complete source tree, including support files.",
      );
  }

  if (input.uses.some((use) => use.skillId === request.skillId && sourceKey(use.source) !== sourceKey(request.source)))
    return blocked("skill-source-conflict", "This logical skill already has a use approved from another source.");

  const bindingEffects: SkillBindingEffect[] = [];
  const metadataEffects: SkillUseEffect[] = [];
  for (const location of request.locations) {
    const key = locationKey(location);
    if (!selectedKeys.has(key)) return blocked("selection-invalid", "The selected copy list is invalid.");
    const candidates = input.bindings.filter(
      (binding) =>
        binding.projectId === location.projectId &&
        binding.harnessId === location.harnessId &&
        bindingArtifactFolder(binding) === location.folderPath,
    );
    if (candidates.length > 1)
      return blocked("binding-ambiguous", "More than one existing binding refers to the selected target.");
    const existingBinding = candidates[0];
    if (existingBinding && !bindingMatchesSource(existingBinding, request.source))
      return blocked("binding-source-conflict", "The selected target is already bound to a different source child.");

    const existingUse = input.uses.find((use) => locationKey(use.location) === key);
    if (
      existingUse &&
      (existingUse.skillId !== request.skillId || sourceKey(existingUse.source) !== sourceKey(request.source))
    )
      return blocked("use-source-conflict", "The selected target already has a different managed skill use.");
    if (existingUse && existingBinding?.bindingId !== existingUse.bindingId)
      return blocked("use-binding-conflict", "The saved use and current binding do not identify the same assignment.");

    const bindingId = existingBinding?.bindingId ?? input.allocateBindingId(location);
    const afterBinding: Binding = {
      bindingId,
      sourceId: request.source.sourceId,
      packageId: request.source.packageId,
      artifactPath: existingBinding?.artifactPath ?? request.source.artifactPath,
      kind: "skill",
      projectId: location.projectId,
      harnessId: location.harnessId,
      boundHash: sourceRevision.hash,
      ownedHash: sourceRevision.hash,
      createdAt: existingBinding?.createdAt ?? input.now,
    };
    const afterUse: ManagedSkillUse = {
      skillId: request.skillId,
      bindingId,
      location,
      source: request.source,
      baseRevisionId: input.baseRevisionId,
    };
    bindingEffects.push({ bindingId, ...(existingBinding ? { before: existingBinding } : {}), after: afterBinding });
    metadataEffects.push({
      skillId: request.skillId,
      location,
      ...(existingUse ? { before: existingUse } : {}),
      after: afterUse,
    });
  }

  const noOp =
    bindingEffects.every((effect) => canonical(effect.before) === canonical(effect.after)) &&
    metadataEffects.every((effect) => canonical(effect.before) === canonical(effect.after));
  return {
    status: "ready",
    noOp,
    baseRevisionId: input.baseRevisionId,
    bindingEffects,
    metadataEffects,
  };
}
