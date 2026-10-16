import { createHash } from "node:crypto";

import type { Binding } from "../assignment-plan";
import { resolveTarget } from "../harness-targets";
import type { SkillEffectFingerprint } from "../skill-management-intent";
import type { SkillBindingEffect, SkillFileSummary, SkillScope } from "../../shared/skill-management-ipc";
import type { SkillAdoptionBaseReference, SkillAdoptionEvidence } from "../../shared/skill-adoption-effects";
import type {
  SkillUseEffect,
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
} from "./types";
import type { SkillAdoptionRequest } from "../../shared/skill-reconciliation-request";
import type { SkillUnboundResolutionRequest } from "../../shared/skill-unbound-resolution-request";
import type {
  SkillUnboundResolutionEvidence,
  SkillUnboundResolutionEnvelope,
} from "../../shared/skill-unbound-resolution-effects";

export type UnboundResolutionPolicyInput = Readonly<{
  request: SkillUnboundResolutionRequest;
  record: LogicalSkillRecord | undefined;
  storeRevision: number;
  source: Readonly<{ ref: SourceSkillRef; rootIdentity: string; revision: SkillRevision }>;
  local: Readonly<{ location: SkillLocationKey; rootIdentity: string; revision: SkillRevision }>;
  envelope: SkillUnboundResolutionEnvelope;
  uses: readonly ManagedSkillUse[];
  bindings: readonly Binding[];
  allocateId: (kind: "step" | "binding" | "base") => string;
  now: string;
}>;

export type UnboundResolutionPolicyResult =
  | Readonly<{ status: "blocked" | "needs-input"; code: string; reason: string }>
  | Readonly<{ status: "adopt-exact"; request: SkillAdoptionRequest }>
  | Readonly<{
      status: "ready";
      stepId: string;
      evidence: SkillUnboundResolutionEvidence;
      scope: SkillScope;
      files: readonly SkillFileSummary[];
      bindingEffects: readonly SkillBindingEffect[];
      metadataEffects: readonly SkillUseEffect[];
      baseReferences: readonly SkillAdoptionBaseReference[];
      fingerprint: SkillEffectFingerprint;
    }>;

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sourceKey(source: SourceSkillRef): string {
  return JSON.stringify([source.sourceId, source.packageId, source.artifactPath]);
}

function sameRevision(left: SkillRevision, right: SkillRevision): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.hash === right.hash &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => {
      const other = right.files[index];
      return file.path === other?.path && file.hash === other.hash && file.byteLength === other.byteLength;
    })
  );
}

function targetFolder(source: SourceSkillRef, location: SkillLocationKey): string | undefined {
  const key = source.artifactPath.split("/").at(-1);
  if (!key) return undefined;
  const target = resolveTarget({ kind: "skill", id: key, harnessId: location.harnessId });
  return target.status === "target" ? target.relativePath : undefined;
}

function bindingFolder(binding: Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  const artifact = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const key = artifact.split("/").at(-1);
  if (!key) return undefined;
  const target = resolveTarget({ kind: "skill", id: key, harnessId: binding.harnessId });
  return target.status === "target" ? target.relativePath : undefined;
}

function blocked(code: string, reason: string): UnboundResolutionPolicyResult {
  return { status: "blocked", code, reason };
}

function makeFiles(
  local: SkillRevision,
  source: SkillRevision,
  projectId: string,
  folderPath: string,
): SkillFileSummary[] {
  const before = new Map(local.files.map((file) => [file.path, file]));
  const after = new Map(source.files.map((file) => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right));
  return paths.flatMap((path) => {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    const change = !oldFile
      ? "add"
      : !newFile
        ? "delete"
        : oldFile.hash === newFile.hash && oldFile.byteLength === newFile.byteLength
          ? "unchanged"
          : "change";
    if (change === "unchanged") return [];
    return [
      {
        rootId: projectId,
        relativePath: `${folderPath}/${path}`,
        change,
        ...(oldFile ? { byteLength: oldFile.byteLength, beforeHash: oldFile.hash } : {}),
        ...(newFile ? { afterHash: newFile.hash, byteLength: newFile.byteLength } : {}),
        ...(!oldFile && newFile?.byteLength === 0 ? { summary: "Empty file" } : {}),
      },
    ];
  });
}

function bindingMatchesSource(binding: Binding, source: SourceSkillRef): boolean {
  return (
    binding.sourceId === source.sourceId &&
    binding.packageId === source.packageId &&
    (binding.artifactPath === source.artifactPath || binding.artifactPath === `${source.artifactPath}/SKILL.md`)
  );
}

export function planUnboundSkillResolution(input: UnboundResolutionPolicyInput): UnboundResolutionPolicyResult {
  const [location] = input.request.locations;
  const record = input.record;
  if (
    !record ||
    record.skillId !== input.request.skillId ||
    !record.locations.some((item) => locationKey(item) === locationKey(location))
  ) {
    return blocked("location-not-in-skill", "The selected location no longer belongs to this logical skill.");
  }
  if (!Number.isSafeInteger(input.storeRevision) || input.storeRevision < 0)
    return blocked("relationship-store-unavailable", "Fresh skill relationship state is unavailable.");
  if (targetFolder(input.request.source, location) !== location.folderPath)
    return blocked("target-key-mismatch", "The selected location does not match the chosen source skill key.");
  if (
    input.uses.some(
      (use) => use.skillId === input.request.skillId && sourceKey(use.source) !== sourceKey(input.request.source),
    )
  )
    return blocked("skill-source-conflict", "This logical skill already has an approved use from another source.");
  if (input.uses.some((use) => locationKey(use.location) === locationKey(location)))
    return blocked(
      "target-use-claimed",
      "The selected copy already has a managed use; review its current management first.",
    );
  if (
    input.bindings.some(
      (binding) =>
        binding.projectId === location.projectId &&
        binding.harnessId === location.harnessId &&
        bindingFolder(binding) === location.folderPath,
    )
  ) {
    return blocked("target-binding-claimed", "The selected copy already has a Binding, including a legacy assignment.");
  }

  if (sameRevision(input.local.revision, input.source.revision)) {
    return {
      status: "adopt-exact",
      request: {
        choice: "adopt-exact",
        skillId: input.request.skillId,
        source: input.request.source,
        locations: [location],
      },
    };
  }

  const bindingId = input.allocateId("binding");
  const baseRevisionId = input.allocateId("base");
  const stepId = input.allocateId("step");
  const binding: Binding = {
    bindingId,
    sourceId: input.request.source.sourceId,
    packageId: input.request.source.packageId,
    artifactPath: input.request.source.artifactPath,
    kind: "skill",
    projectId: location.projectId,
    harnessId: location.harnessId,
    boundHash: input.source.revision.hash,
    ownedHash: input.source.revision.hash,
    createdAt: input.now,
  };
  const use: ManagedSkillUse = {
    skillId: input.request.skillId,
    bindingId,
    location,
    source: input.request.source,
    baseRevisionId,
  };
  const files = makeFiles(input.local.revision, input.source.revision, location.projectId, location.folderPath);
  const scope: SkillScope = {
    sourceId: input.request.source.sourceId,
    packageId: input.request.source.packageId,
    artifactPath: input.request.source.artifactPath,
    targets: [{ projectId: location.projectId, harnessId: location.harnessId, bindingId }],
  };
  const evidence: SkillUnboundResolutionEvidence = {
    choice: "link-canonical",
    skillId: input.request.skillId,
    storeRevision: input.storeRevision,
    record,
    source: input.source,
    local: input.local,
    priorManagement: { use: "absent", binding: "absent", base: "unknown" },
  };
  const bindingEffects: SkillBindingEffect[] = [{ bindingId, after: binding }];
  const metadataEffects: SkillUseEffect[] = [{ skillId: input.request.skillId, location, after: use }];
  const baseReferences: SkillAdoptionBaseReference[] = [{ baseRevisionId, revision: input.source.revision }];
  const fingerprint: SkillEffectFingerprint = {
    scope,
    files,
    bindings: bindingEffects,
    actions: files.map((file) => ({
      rootId: file.rootId,
      kind: file.change === "delete" ? "delete-file" : "write-file",
      relativePath: file.relativePath,
      ...(file.beforeHash ? { beforeHash: file.beforeHash } : {}),
      ...(file.afterHash ? { afterHash: file.afterHash } : {}),
    })),
    metadataEffects,
    baseReferences,
    unboundResolutionEvidence: evidence,
    unboundResolutionEnvelope: input.envelope,
  };
  return {
    status: "ready",
    stepId,
    evidence,
    scope,
    files,
    bindingEffects,
    metadataEffects,
    baseReferences,
    fingerprint,
  };
}
