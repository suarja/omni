import { parseBinding } from "./bindings-ipc";
import {
  parseSkillLocationKey,
  parseLogicalSkillRecord,
  parseManagedSkillUse,
  parseSkillRevision,
  parseSourceSkillRef,
} from "../domain/skill-reconciliation/validation";
import { parseSkillVariantOrigin, type SkillVariantOrigin } from "../domain/skill-reconciliation/variant-origin";
import { parseSkillVariantCaptureRequest, type SkillVariantCaptureRequest } from "./skill-variant-capture-request";
import type { Binding } from "../domain/assignment-plan";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SourceSkillRef,
} from "../domain/skill-reconciliation/types";
import type { SkillScope } from "./skill-management-ipc";

export type SkillVariantCaptureEvidence = Readonly<{
  request: SkillVariantCaptureRequest;
  storeRevision: number;
  record: LogicalSkillRecord;
  binding?: Binding;
  use?: ManagedSkillUse;
  local: Readonly<{ rootIdentity: string; revision: SkillRevision }>;
  destination: Readonly<{
    source: SourceSkillRef;
    rootIdentity: string;
    packageRoot: string;
    manifest: Readonly<{ relativePath: string; beforeHash: string }>;
    absent: true;
  }>;
  origin: SkillVariantOrigin;
}>;

export type SkillVariantCaptureDetails = Readonly<{
  choice: "keep-variant";
  skillId: string;
  variantId: string;
  location: SkillLocationKey;
  destination: SourceSkillRef;
  status: "applied" | "restored" | "failed" | "unknown";
}>;

export type ReadSkillVariantOriginResponse =
  | Readonly<{ status: "ready"; source: SourceSkillRef; origin: SkillVariantOrigin }>
  | Readonly<{ status: "absent"; source: SourceSkillRef }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type ReadSkillVariantOriginRequest = Readonly<{ source: SourceSkillRef }>;

type RecordValue = Record<string, unknown>;
const HASH = /^[a-f0-9]{64}$/u;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}

function safePath(value: unknown, label: string): string {
  const path = text(value, label).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return path;
}

function rootIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sameSource(left: SourceSkillRef, right: SourceSkillRef): boolean {
  return (
    left.sourceId === right.sourceId && left.packageId === right.packageId && left.artifactPath === right.artifactPath
  );
}

function bindingMatches(binding: Binding, use: ManagedSkillUse): boolean {
  const folder = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  return (
    binding.bindingId === use.bindingId &&
    binding.kind === "skill" &&
    binding.projectId === use.location.projectId &&
    binding.harnessId === use.location.harnessId &&
    binding.sourceId === use.source.sourceId &&
    binding.packageId === use.source.packageId &&
    folder === use.source.artifactPath
  );
}

export function parseSkillVariantCaptureEvidence(value: unknown): SkillVariantCaptureEvidence {
  const input = record(value, "Skill variant capture evidence");
  keys(
    input,
    ["request", "storeRevision", "record", "binding", "use", "local", "destination", "origin"],
    "Skill variant capture evidence",
  );
  const request = parseSkillVariantCaptureRequest(input.request);
  if (!Number.isSafeInteger(input.storeRevision) || Number(input.storeRevision) < 0)
    throw new Error("Skill variant store revision is invalid.");
  const recordValue = parseLogicalSkillRecord(input.record);
  const location = request.locations[0]!;
  if (
    recordValue.skillId !== request.skillId ||
    !recordValue.locations.some((entry) => locationKey(entry) === locationKey(location))
  ) {
    throw new Error("Skill variant evidence does not match the selected logical copy.");
  }
  const binding = input.binding === undefined ? undefined : parseBinding(input.binding);
  const use = input.use === undefined ? undefined : parseManagedSkillUse(input.use);
  if (
    (binding === undefined) !== (use === undefined) ||
    (use &&
      (use.skillId !== request.skillId ||
        locationKey(use.location) !== locationKey(location) ||
        !bindingMatches(binding!, use)))
  ) {
    throw new Error("Skill variant management evidence is contradictory.");
  }
  const local = record(input.local, "Skill variant local evidence");
  keys(local, ["rootIdentity", "revision"], "Skill variant local evidence");
  const destination = record(input.destination, "Skill variant destination evidence");
  keys(
    destination,
    ["source", "rootIdentity", "packageRoot", "manifest", "absent"],
    "Skill variant destination evidence",
  );
  if (destination.absent !== true) throw new Error("Skill variant destination must be absent before capture.");
  const source = parseSourceSkillRef(destination.source);
  const expectedSource = {
    sourceId: request.destination.sourceId,
    packageId: request.destination.packageId,
    artifactPath: `skills/${request.destination.skillKey}`,
  };
  if (!sameSource(source, expectedSource))
    throw new Error("Skill variant destination does not match the explicit selection.");
  const packageRoot = safePath(destination.packageRoot, "Package root");
  const manifest = record(destination.manifest, "Plugin manifest evidence");
  keys(manifest, ["relativePath", "beforeHash"], "Plugin manifest evidence");
  const relativePath = safePath(manifest.relativePath, "Plugin manifest path");
  const physicalPackageRoot = packageRoot === "root" ? "" : packageRoot;
  if (
    relativePath !== (physicalPackageRoot ? `${physicalPackageRoot}/omni.plugin.json` : "omni.plugin.json") ||
    typeof manifest.beforeHash !== "string" ||
    !HASH.test(manifest.beforeHash)
  ) {
    throw new Error("Skill variant manifest evidence is invalid.");
  }
  const origin = parseSkillVariantOrigin(input.origin);
  if (
    origin.forkOf !== request.skillId ||
    locationKey(origin.capturedFrom.location) !== locationKey(location) ||
    (origin.approvedSource !== undefined) !== (use !== undefined) ||
    (use && !sameSource(origin.approvedSource!, use.source))
  ) {
    throw new Error("Skill variant origin does not match its saved capture evidence.");
  }
  return {
    request,
    storeRevision: Number(input.storeRevision),
    record: recordValue,
    ...(binding ? { binding } : {}),
    ...(use ? { use } : {}),
    local: {
      rootIdentity: rootIdentity(local.rootIdentity, "Project root identity"),
      revision: parseSkillRevision(local.revision),
    },
    destination: {
      source,
      rootIdentity: rootIdentity(destination.rootIdentity, "Source root identity"),
      packageRoot,
      manifest: { relativePath, beforeHash: manifest.beforeHash },
      absent: true,
    },
    origin,
  };
}

export function parseSkillVariantCaptureDetails(value: unknown): SkillVariantCaptureDetails {
  const input = record(value, "Skill variant capture result");
  keys(input, ["choice", "skillId", "variantId", "location", "destination", "status"], "Skill variant capture result");
  if (
    input.choice !== "keep-variant" ||
    typeof input.skillId !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(input.skillId) ||
    typeof input.variantId !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(input.variantId) ||
    !["applied", "restored", "failed", "unknown"].includes(String(input.status))
  )
    throw new Error("Skill variant result is invalid.");
  return {
    choice: "keep-variant",
    skillId: input.skillId.toLowerCase(),
    variantId: input.variantId.toLowerCase(),
    location: parseSkillLocationKey(input.location),
    destination: parseSourceSkillRef(input.destination),
    status: input.status as SkillVariantCaptureDetails["status"],
  };
}

export function parseReadSkillVariantOriginResponse(
  value: unknown,
  expectedSource?: SourceSkillRef,
): ReadSkillVariantOriginResponse {
  const input = record(value, "Skill variant origin response");
  if (input.status === "unavailable") {
    keys(input, ["status", "reason"], "Unavailable skill variant response");
    return { status: "unavailable", reason: text(input.reason, "Unavailable reason", 512) };
  }
  if (input.status !== "ready" && input.status !== "absent")
    throw new Error("Skill variant origin response status is invalid.");
  keys(
    input,
    input.status === "ready" ? ["status", "source", "origin"] : ["status", "source"],
    "Skill variant origin response",
  );
  const source = parseSourceSkillRef(input.source);
  if (expectedSource && !sameSource(source, expectedSource))
    throw new Error("Skill variant origin response changed its requested source.");
  if (input.status === "absent") return { status: "absent", source };
  const origin = parseSkillVariantOrigin(input.origin);
  if (origin.approvedSource && sameSource(origin.approvedSource, source))
    throw new Error("A captured variant cannot approve itself as its source.");
  return { status: "ready", source, origin };
}

export function parseReadSkillVariantOriginRequest(value: unknown): ReadSkillVariantOriginRequest {
  const input = record(value, "Skill variant origin request");
  keys(input, ["source"], "Skill variant origin request");
  return { source: parseSourceSkillRef(input.source) };
}

export function parseSkillVariantCaptureStepMetadata(
  value: Readonly<Record<string, unknown>>,
  scope: SkillScope,
  files: readonly Readonly<{
    rootId: string;
    relativePath: string;
    change: string;
    beforeHash?: string;
    afterHash?: string;
  }>[],
  actions: readonly Readonly<{ kind: string; relativePath: string; beforeHash?: string; afterHash?: string }>[],
  planKind: string,
  bindingEffects: readonly unknown[],
): Readonly<{ variantCaptureEvidence: SkillVariantCaptureEvidence }> | undefined {
  if (value.variantCaptureEvidence === undefined) return undefined;
  if (
    value.metadataEffects !== undefined ||
    value.baseReferences !== undefined ||
    value.adoptionEvidence !== undefined ||
    value.resolutionEvidence !== undefined ||
    bindingEffects.length !== 0
  ) {
    throw new Error("Skill variant capture cannot change project relationships, bindings or bases.");
  }
  const evidence = parseSkillVariantCaptureEvidence(value.variantCaptureEvidence);
  const location = evidence.request.locations[0]!;
  if (
    scope.sourceId !== evidence.destination.source.sourceId ||
    scope.packageId !== evidence.destination.source.packageId ||
    scope.artifactPath !== evidence.destination.source.artifactPath ||
    scope.targets.length !== 1 ||
    scope.targets[0]?.projectId !== location.projectId ||
    scope.targets[0]?.harnessId !== location.harnessId ||
    scope.targets[0]?.bindingId !== undefined
  ) {
    throw new Error("Skill variant evidence does not match its reserved scope.");
  }
  const packageRoot = evidence.destination.packageRoot === "root" ? "" : evidence.destination.packageRoot;
  const prefix = `${packageRoot ? `${packageRoot}/` : ""}${evidence.destination.source.artifactPath}/`;
  const expectedFiles = evidence.local.revision.files.map((file) => `${prefix}${file.path}`);
  const manifestFiles = files.filter((file) => file.relativePath === evidence.destination.manifest.relativePath);
  if (planKind === "capture-skill") {
    const copiedFiles = files.filter((file) => file.relativePath !== evidence.destination.manifest.relativePath);
    const wroteFiles = actions.filter(
      (action) => action.kind === "write-file" && action.relativePath !== evidence.destination.manifest.relativePath,
    );
    const manifestAction = actions.filter(
      (action) => action.kind === "write-file" && action.relativePath === evidence.destination.manifest.relativePath,
    );
    const directories = actions.filter((action) => action.kind === "create-directory");
    const skillsRoot = `${packageRoot ? `${packageRoot}/` : ""}skills`;
    if (
      copiedFiles.length !== expectedFiles.length ||
      copiedFiles.some(
        (file) =>
          file.rootId !== evidence.destination.source.sourceId ||
          file.change !== "add" ||
          !file.relativePath.startsWith(prefix),
      ) ||
      expectedFiles.some(
        (path) =>
          !copiedFiles.some(
            (file) =>
              file.relativePath === path &&
              file.afterHash ===
                evidence.local.revision.files.find((revision) => path === `${prefix}${revision.path}`)?.hash,
          ),
      ) ||
      manifestFiles.length !== 1 ||
      manifestFiles[0]?.change !== "change" ||
      manifestFiles[0]?.beforeHash !== evidence.destination.manifest.beforeHash ||
      manifestFiles[0]?.afterHash === undefined ||
      manifestAction.length !== 1 ||
      manifestAction[0]?.beforeHash !== evidence.destination.manifest.beforeHash ||
      manifestAction[0]?.afterHash !== manifestFiles[0]?.afterHash ||
      wroteFiles.length !== expectedFiles.length ||
      wroteFiles.some((action) => !expectedFiles.includes(action.relativePath)) ||
      actions.some((action) => !["write-file", "create-directory"].includes(action.kind)) ||
      directories.some(
        (action) => action.relativePath !== skillsRoot && !action.relativePath.startsWith(`${prefix.slice(0, -1)}`),
      )
    ) {
      throw new Error("Skill variant capture may only add files to its selected destination.");
    }
  } else if (planKind === "restore-apply") {
    if (
      files.some(
        (file) =>
          file.rootId !== evidence.destination.source.sourceId ||
          (!file.relativePath.startsWith(prefix) && file.relativePath !== evidence.destination.manifest.relativePath),
      ) ||
      actions.some(
        (action) =>
          !action.relativePath.startsWith(prefix) && action.relativePath !== evidence.destination.manifest.relativePath,
      ) ||
      actions.some((action) => !["delete-file", "write-file"].includes(action.kind))
    ) {
      throw new Error("Skill variant inverse exceeds its captured destination.");
    }
  } else throw new Error("Skill variant evidence is attached to an unsupported operation.");
  return { variantCaptureEvidence: evidence };
}
