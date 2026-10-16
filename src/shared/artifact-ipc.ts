import type { CorruptRegistryResult, EntryKind } from "../domain/project-source-registry";

export const ARTIFACT_IPC_CHANNELS = {
  readArtifact: "omni:artifact:read",
} as const;

export type ReadArtifactRequest = Readonly<{
  kind: EntryKind;
  id: string;
  grantHandle: string;
  relativePath: string;
}>;

export type ReadArtifactResponse =
  | Readonly<{ status: "read"; content: string; byteLength: number; truncated: boolean }>
  | Readonly<{ status: "binary"; byteLength: number }>
  | Readonly<{ status: "too-large"; byteLength: number; limit: number }>
  | Readonly<{ status: "unavailable"; diagnostic: string }>
  | Readonly<{ status: "denied" }>
  | CorruptRegistryResult;

export interface ArtifactDesktopApi {
  readArtifact(request: ReadArtifactRequest): Promise<ReadArtifactResponse>;
}

type RecordValue = Record<string, unknown>;

function assertRecord(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as RecordValue;
}

function assertKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has an unexpected field "${key}".`);
  }
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function readId(value: unknown): string {
  const id = readText(value, "Entry id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error("Entry id is malformed.");
  return id;
}

function readGrantHandle(value: unknown): string {
  const handle = readText(value, "Grant handle");
  if (
    handle.includes("/") ||
    handle.includes("\\") ||
    handle.includes("..") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(handle)
  ) {
    throw new Error("Grant handle must be opaque.");
  }
  return handle;
}

function readRelativePath(value: unknown): string {
  const path = readText(value, "Artifact path");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(path)) throw new Error("Artifact path contains control characters.");
  return path;
}

function readDiagnostic(value: unknown): string {
  const diagnostic = readText(value, "Artifact diagnostic");
  if (
    diagnostic.length > 240 ||
    /[\r\n]/.test(diagnostic) ||
    /(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(diagnostic)
  ) {
    throw new Error("Artifact diagnostic is not safe for IPC.");
  }
  return diagnostic;
}

function readByteLength(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function parseCorrupt(value: RecordValue): CorruptRegistryResult {
  assertKeys(value, ["status", "diagnostic", "recoveryAvailable"], "Corrupt artifact response");
  if (value.status !== "corrupt" || typeof value.recoveryAvailable !== "boolean") {
    throw new Error("Corrupt artifact response is invalid.");
  }
  return {
    status: "corrupt",
    diagnostic: readDiagnostic(value.diagnostic),
    recoveryAvailable: value.recoveryAvailable,
  };
}

export function parseReadArtifactRequest(value: unknown): ReadArtifactRequest {
  const request = assertRecord(value, "Artifact read request");
  assertKeys(request, ["kind", "id", "grantHandle", "relativePath"], "Artifact read request");
  if (request.kind !== "project" && request.kind !== "source") throw new Error("Entry kind is invalid.");
  return {
    kind: request.kind,
    id: readId(request.id),
    grantHandle: readGrantHandle(request.grantHandle),
    relativePath: readRelativePath(request.relativePath),
  };
}

export function parseReadArtifactResponse(value: unknown): ReadArtifactResponse {
  const response = assertRecord(value, "Artifact read response");
  if (response.status === "corrupt") return parseCorrupt(response);
  if (response.status === "read") {
    assertKeys(response, ["status", "content", "byteLength", "truncated"], "Artifact read response");
    if (typeof response.content !== "string" || typeof response.truncated !== "boolean")
      throw new Error("Artifact read response is invalid.");
    return {
      status: "read",
      content: response.content,
      byteLength: readByteLength(response.byteLength, "Artifact byte length"),
      truncated: response.truncated,
    };
  }
  if (response.status === "binary") {
    assertKeys(response, ["status", "byteLength"], "Binary artifact response");
    return { status: "binary", byteLength: readByteLength(response.byteLength, "Artifact byte length") };
  }
  if (response.status === "too-large") {
    assertKeys(response, ["status", "byteLength", "limit"], "Large artifact response");
    return {
      status: "too-large",
      byteLength: readByteLength(response.byteLength, "Artifact byte length"),
      limit: readByteLength(response.limit, "Artifact size limit"),
    };
  }
  if (response.status === "unavailable") {
    assertKeys(response, ["status", "diagnostic"], "Unavailable artifact response");
    return { status: "unavailable", diagnostic: readDiagnostic(response.diagnostic) };
  }
  if (response.status === "denied") {
    assertKeys(response, ["status"], "Denied artifact response");
    return { status: "denied" };
  }
  throw new Error("Artifact read response status is invalid.");
}
