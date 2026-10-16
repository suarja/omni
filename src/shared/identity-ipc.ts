import type { InventoryArtifactKind } from "../domain/inventory";
import type { EntryKind, EntryRef, CorruptRegistryResult } from "../domain/project-source-registry";
import type { ArtifactIdentity } from "../domain/identity";

export const IDENTITY_IPC_CHANNELS = { hashArtifacts: "omni:identity:hash" } as const;

export type HashArtifactRequest = Readonly<{ artifactId: string; relativePath: string; kind: InventoryArtifactKind }>;
export type HashArtifactsRequest = Readonly<{
  kind: EntryKind;
  id: string;
  grantHandle: string;
  artifacts: readonly HashArtifactRequest[];
}>;
export type HashSkippedReason = "too-large" | "binary" | "unavailable" | "denied";
export type HashArtifactsResponse =
  | Readonly<{
      status: "hashed";
      subject: EntryRef;
      identities: readonly ArtifactIdentity[];
      skipped: readonly Readonly<{ artifactId: string; reason: HashSkippedReason }>[];
    }>
  | Readonly<{ status: "denied" }>
  | CorruptRegistryResult;

export interface IdentityDesktopApi {
  hashArtifacts(request: HashArtifactsRequest): Promise<HashArtifactsResponse>;
}

type RecordValue = Record<string, unknown>;
const ARTIFACT_KINDS: readonly InventoryArtifactKind[] = [
  "skill",
  "rule",
  "agent",
  "command",
  "hook",
  "mcp-config",
  "plugin-manifest",
  "marketplace-manifest",
  "instruction",
  "unknown",
];

function assertRecord(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function assertKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label} has an unexpected field "${key}".`);
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function readId(value: unknown, label: string): string {
  const id = readText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(id) || id.split("/").some((part) => part === ".."))
    throw new Error(`${label} is malformed.`);
  return id;
}

function readOpaque(value: unknown, label: string): string {
  const text = readText(value, label);
  if (text.includes("/") || text.includes("\\") || text.includes("..") || /[\u0000-\u001f\u007f-\u009f]/u.test(text))
    throw new Error(`${label} must be opaque.`);
  return text;
}

function readRelativePath(value: unknown, label: string): string {
  const path = readText(value, label).replaceAll("\\", "/");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(path) || path.startsWith("/") || /^[A-Za-z]:\//.test(path))
    throw new Error(`${label} must be relative.`);
  return path;
}

function readByteLength(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function readHash(value: unknown): string {
  const hash = readText(value, "Content hash");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Content hash must be a lowercase SHA-256 hash.");
  return hash;
}

function readDiagnostic(value: unknown): string {
  const diagnostic = readText(value, "Identity diagnostic");
  if (
    diagnostic.length > 240 ||
    /[\r\n]/.test(diagnostic) ||
    /(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(diagnostic)
  )
    throw new Error("Identity diagnostic is not safe for IPC.");
  return diagnostic;
}

function parseCorrupt(value: RecordValue): CorruptRegistryResult {
  assertKeys(value, ["status", "diagnostic", "recoveryAvailable"], "Corrupt identity response");
  if (value.status !== "corrupt" || typeof value.recoveryAvailable !== "boolean")
    throw new Error("Corrupt identity response is invalid.");
  return {
    status: "corrupt",
    diagnostic: readDiagnostic(value.diagnostic),
    recoveryAvailable: value.recoveryAvailable,
  };
}

function parseEntryRef(value: unknown): EntryRef {
  const ref = assertRecord(value, "Identity root");
  assertKeys(ref, ["kind", "id"], "Identity root");
  if (ref.kind !== "project" && ref.kind !== "source") throw new Error("Identity root kind is invalid.");
  return { kind: ref.kind, id: readId(ref.id, "Identity root id") };
}

function parseArtifactRequest(value: unknown): HashArtifactRequest {
  const artifact = assertRecord(value, "Hash artifact");
  assertKeys(artifact, ["artifactId", "relativePath", "kind"], "Hash artifact");
  if (!ARTIFACT_KINDS.includes(artifact.kind as InventoryArtifactKind))
    throw new Error("Hash artifact kind is invalid.");
  return {
    artifactId: readId(artifact.artifactId, "Artifact id"),
    relativePath: readRelativePath(artifact.relativePath, "Artifact path"),
    kind: artifact.kind as InventoryArtifactKind,
  };
}

export function parseHashArtifactsRequest(value: unknown): HashArtifactsRequest {
  const request = assertRecord(value, "Hash artifacts request");
  assertKeys(request, ["kind", "id", "grantHandle", "artifacts"], "Hash artifacts request");
  if (request.kind !== "project" && request.kind !== "source") throw new Error("Entry kind is invalid.");
  if (!Array.isArray(request.artifacts)) throw new Error("Hash artifacts must be an array.");
  const artifacts = request.artifacts.map(parseArtifactRequest);
  if (new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length)
    throw new Error("Hash artifact ids must be unique.");
  return {
    kind: request.kind,
    id: readId(request.id, "Entry id"),
    grantHandle: readOpaque(request.grantHandle, "Grant handle"),
    artifacts,
  };
}

function parseIdentity(value: unknown): ArtifactIdentity {
  const identity = assertRecord(value, "Artifact identity");
  assertKeys(
    identity,
    ["artifactId", "logicalId", "contentHash", "byteLength", "executionClass", "kind", "provenance"],
    "Artifact identity",
  );
  if (identity.executionClass !== "static" && identity.executionClass !== "executable")
    throw new Error("Artifact execution class is invalid.");
  if (!ARTIFACT_KINDS.includes(identity.kind as InventoryArtifactKind))
    throw new Error("Artifact identity kind is invalid.");
  const provenance = assertRecord(identity.provenance, "Artifact provenance");
  assertKeys(provenance, ["root", "packageId", "relativePath"], "Artifact provenance");
  return {
    artifactId: readId(identity.artifactId, "Artifact id"),
    logicalId: readRelativePath(identity.logicalId, "Logical id"),
    contentHash: readHash(identity.contentHash),
    byteLength: readByteLength(identity.byteLength, "Artifact byte length"),
    executionClass: identity.executionClass,
    kind: identity.kind as InventoryArtifactKind,
    provenance: {
      root: parseEntryRef(provenance.root),
      ...(provenance.packageId === undefined
        ? {}
        : { packageId: readRelativePath(provenance.packageId, "Package id") }),
      relativePath: readRelativePath(provenance.relativePath, "Artifact path"),
    },
  };
}

export function parseHashArtifactsResponse(value: unknown): HashArtifactsResponse {
  const response = assertRecord(value, "Hash artifacts response");
  if (response.status === "corrupt") return parseCorrupt(response);
  if (response.status === "denied") {
    assertKeys(response, ["status"], "Denied identity response");
    return { status: "denied" };
  }
  assertKeys(response, ["status", "subject", "identities", "skipped"], "Hash artifacts response");
  if (response.status !== "hashed" || !Array.isArray(response.identities) || !Array.isArray(response.skipped))
    throw new Error("Hash artifacts response is invalid.");
  const skipped = response.skipped.map((value) => {
    const item = assertRecord(value, "Skipped artifact");
    assertKeys(item, ["artifactId", "reason"], "Skipped artifact");
    if (!["too-large", "binary", "unavailable", "denied"].includes(String(item.reason)))
      throw new Error("Skipped artifact reason is invalid.");
    return { artifactId: readId(item.artifactId, "Artifact id"), reason: item.reason as HashSkippedReason };
  });
  return {
    status: "hashed",
    subject: parseEntryRef(response.subject),
    identities: response.identities.map(parseIdentity),
    skipped,
  };
}
