import { createHash } from "node:crypto";

import type { Binding } from "../assignment-plan";
import type { SkillEffectFingerprint } from "../skill-management-intent";
import type { SkillBindingEffect, SkillFileSummary, SkillScope } from "../../shared/skill-management-ipc";
import type { SkillVariantCaptureRequest } from "../../shared/skill-variant-capture-request";
import type { SkillVariantCaptureEvidence } from "../../shared/skill-variant-effects";
import type { LogicalSkillRecord, ManagedSkillUse, SkillLocationKey, SkillRevision, SourceSkillRef } from "./types";
import type { SkillVariantOrigin } from "./variant-origin";

type ReadyRevision = Readonly<{ rootIdentity: string; revision: SkillRevision }>;
type VariantDestination = Readonly<{
  source: SourceSkillRef;
  rootIdentity: string;
  packageRoot: string;
  manifestPath: string;
  beforeManifestHash: string;
  existingArtifactKeys: readonly string[];
  existingFolderNames?: readonly string[];
}>;

export type SkillVariantCapturePolicyInput = Readonly<{
  request: SkillVariantCaptureRequest;
  record: LogicalSkillRecord | undefined;
  storeRevision: number;
  local: ReadyRevision;
  destination: VariantDestination;
  intentId: string;
  createdAt: string;
  use?: ManagedSkillUse;
  binding?: Binding;
}>;

export type SkillVariantCapturePlan =
  | Readonly<{
      status: "ready";
      evidence: SkillVariantCaptureEvidence;
      scope: SkillScope;
      files: readonly SkillFileSummary[];
      bindingEffects: readonly SkillBindingEffect[];
      metadataEffects: readonly [];
      baseReferences: readonly [];
      fingerprint: SkillEffectFingerprint;
    }>
  | Readonly<{ status: "blocked"; code: string; reason: string }>;

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function variantId(intentId: string): string {
  const hex = createHash("sha256")
    .update(`${intentId}\npersonal-skill-variant`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function blocked(code: string, reason: string): SkillVariantCapturePlan {
  return { status: "blocked", code, reason };
}

function bindingMatches(binding: Binding, use: ManagedSkillUse): boolean {
  const path = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  return (
    binding.bindingId === use.bindingId &&
    binding.kind === "skill" &&
    binding.projectId === use.location.projectId &&
    binding.harnessId === use.location.harnessId &&
    binding.sourceId === use.source.sourceId &&
    binding.packageId === use.source.packageId &&
    path === use.source.artifactPath
  );
}

function collides(key: string, destination: VariantDestination): boolean {
  const expected = `skills/${key}`.toLocaleLowerCase("en-US");
  return [
    ...destination.existingArtifactKeys,
    ...(destination.existingFolderNames ?? []).map((name) => `skills/${name}`),
  ].some((candidate) => candidate.replaceAll("\\", "/").toLocaleLowerCase("en-US") === expected);
}

function artifactFiles(source: SourceSkillRef, packageRoot: string, revision: SkillRevision): SkillFileSummary[] {
  const physicalRoot = packageRoot === "root" ? "" : packageRoot;
  return revision.files.map((file) => ({
    rootId: source.sourceId,
    relativePath: [physicalRoot, source.artifactPath, file.path].filter(Boolean).join("/"),
    change: "add",
    byteLength: file.byteLength,
    afterHash: file.hash,
    ...(file.byteLength === 0 ? { summary: "Empty file" } : {}),
  }));
}

export function planSkillVariantCapture(input: SkillVariantCapturePolicyInput): SkillVariantCapturePlan {
  const [location] = input.request.locations;
  const record = input.record;
  if (
    !record ||
    record.skillId !== input.request.skillId ||
    !record.locations.some((item) => locationKey(item) === locationKey(location))
  ) {
    return blocked("location-not-in-skill", "The selected copy no longer belongs to this logical skill.");
  }
  if (!Number.isSafeInteger(input.storeRevision) || input.storeRevision < 0)
    return blocked("store-unavailable", "Fresh skill relationship state is unavailable.");
  if (
    input.destination.source.sourceId !== input.request.destination.sourceId ||
    input.destination.source.packageId !== input.request.destination.packageId ||
    input.destination.source.artifactPath !== `skills/${input.request.destination.skillKey}`
  ) {
    return blocked("destination-mismatch", "The observed destination does not match the explicit selection.");
  }
  if (collides(input.request.destination.skillKey, input.destination))
    return blocked("destination-collision", "The skill key already exists in the selected plugin.");
  if ((input.use === undefined) !== (input.binding === undefined))
    return blocked("management-contradiction", "The selected copy has inconsistent managed-use and Binding records.");
  if (
    input.use &&
    input.binding &&
    (input.use.skillId !== input.request.skillId ||
      locationKey(input.use.location) !== locationKey(location) ||
      !bindingMatches(input.binding, input.use))
  )
    return blocked("management-contradiction", "The selected copy has inconsistent managed-use and Binding records.");
  const source = input.destination.source;
  const origin: SkillVariantOrigin = {
    schemaVersion: 1,
    variantId: variantId(input.intentId),
    forkOf: input.request.skillId,
    capturedAt: input.createdAt,
    capturedFrom: { location, revision: input.local.revision },
    ...(record.declaration ? { declaredOrigin: record.declaration } : {}),
    ...(input.use && input.binding ? { approvedSource: input.use.source } : {}),
  };
  const evidence: SkillVariantCaptureEvidence = {
    request: input.request,
    storeRevision: input.storeRevision,
    record,
    ...(input.binding ? { binding: input.binding } : {}),
    ...(input.use ? { use: input.use } : {}),
    local: { rootIdentity: input.local.rootIdentity, revision: input.local.revision },
    destination: {
      source,
      rootIdentity: input.destination.rootIdentity,
      packageRoot: input.destination.packageRoot,
      manifest: { relativePath: input.destination.manifestPath, beforeHash: input.destination.beforeManifestHash },
      absent: true,
    },
    origin,
  };
  const scope: SkillScope = {
    sourceId: source.sourceId,
    packageId: source.packageId,
    artifactPath: source.artifactPath,
    targets: [{ projectId: location.projectId, harnessId: location.harnessId }],
  };
  const files = artifactFiles(source, input.destination.packageRoot, input.local.revision);
  const fingerprint: SkillEffectFingerprint = {
    scope,
    files,
    bindings: [],
    actions: files.map(({ rootId, relativePath, afterHash }) => ({
      rootId,
      kind: "write-file",
      relativePath,
      afterHash,
    })),
    variantCaptureEvidence: evidence,
  };
  return {
    status: "ready",
    evidence,
    scope,
    files,
    bindingEffects: [],
    metadataEffects: [],
    baseReferences: [],
    fingerprint,
  };
}
