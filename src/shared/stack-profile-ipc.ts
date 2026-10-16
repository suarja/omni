import type { StackHarness, StackLanguage, StackProfile, StackTag } from "../domain/stack-profile";

export const STACK_PROFILE_IPC_CHANNELS = { get: "omni:projects:stack-profile" } as const;

export type StackProfileRequest = Readonly<{ projectId: string; grantHandle: string; refresh?: boolean }>;

export type StackProfileResponse =
  | Readonly<{ status: "ready"; profile: StackProfile; cached: boolean }>
  | Readonly<{ status: "denied" }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export interface StackProfileDesktopApi {
  getStackProfile(request: StackProfileRequest): Promise<StackProfileResponse>;
}

type RecordValue = Record<string, unknown>;
const HARNESSES: readonly StackHarness[] = ["claude-code", "codex", "cursor"];

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
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function readId(value: unknown, label: string): string {
  const id = readText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`${label} is malformed.`);
  return id;
}

/** True if `text` contains a C0 or C1 control character (kept out of every opaque handle and evidence string). */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function readOpaque(value: unknown, label: string): string {
  const text = readText(value, label);
  if (text.includes("/") || text.includes("\\") || text.includes("..") || hasControlCharacter(text)) {
    throw new Error(`${label} must be opaque.`);
  }
  return text;
}

/** IPC-safe evidence and label text: no control characters, no absolute-path fragments, bounded length. */
function readSafeText(value: unknown, label: string, maxLength: number): string {
  const text = readText(value, label);
  if (
    text.length > maxLength ||
    /[\r\n]/.test(text) ||
    text.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(text) ||
    /(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(text)
  ) {
    throw new Error(`${label} is not safe for IPC.`);
  }
  return text;
}

function readTagId(value: unknown): string {
  const id = readText(value, "Stack tag id");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Stack tag id is malformed.");
  return id;
}

function readComputedAt(value: unknown): string {
  const text = readText(value, "Stack profile computedAt");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new Error("Stack profile computedAt must be an ISO 8601 timestamp.");
  }
  return text;
}

function readTreeHash(value: unknown): string {
  const hash = readText(value, "Stack profile tree hash");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Stack profile tree hash must be a lowercase SHA-256 hash.");
  return hash;
}

function readFileCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Stack language file count must be a non-negative integer.");
  }
  return value;
}

function parseTag(value: unknown): StackTag {
  const record = assertRecord(value, "Stack tag");
  assertKeys(record, ["id", "label", "evidence"], "Stack tag");
  if (!Array.isArray(record.evidence)) throw new Error("Stack tag evidence must be an array.");
  return {
    id: readTagId(record.id),
    label: readSafeText(record.label, "Stack tag label", 120),
    evidence: record.evidence.map((item) => readSafeText(item, "Stack tag evidence", 300)),
  };
}

function parseLanguage(value: unknown): StackLanguage {
  const record = assertRecord(value, "Stack language");
  assertKeys(record, ["id", "files"], "Stack language");
  return { id: readSafeText(record.id, "Stack language id", 60), files: readFileCount(record.files) };
}

function parseHarnesses(value: unknown): readonly StackHarness[] {
  if (!Array.isArray(value)) throw new Error("Stack harnesses must be an array.");
  const harnesses = value.map((item) => {
    if (!HARNESSES.includes(item as StackHarness)) throw new Error("Stack harness is invalid.");
    return item as StackHarness;
  });
  if (new Set(harnesses).size !== harnesses.length) throw new Error("Stack harnesses must be unique.");
  return harnesses;
}

/** Exported so the main-process cache store validates persisted profiles with this same parser. */
export function parseStackProfile(value: unknown): StackProfile {
  const record = assertRecord(value, "Stack profile");
  assertKeys(record, ["tags", "languages", "harnesses", "computedAt", "treeHash"], "Stack profile");
  if (!Array.isArray(record.tags)) throw new Error("Stack profile tags must be an array.");
  if (!Array.isArray(record.languages)) throw new Error("Stack profile languages must be an array.");
  return {
    tags: record.tags.map(parseTag),
    languages: record.languages.map(parseLanguage),
    harnesses: parseHarnesses(record.harnesses),
    computedAt: readComputedAt(record.computedAt),
    treeHash: readTreeHash(record.treeHash),
  };
}

export function parseStackProfileRequest(value: unknown): StackProfileRequest {
  const request = assertRecord(value, "Stack profile request");
  assertKeys(request, ["projectId", "grantHandle", "refresh"], "Stack profile request");
  if (request.refresh !== undefined && typeof request.refresh !== "boolean") {
    throw new Error("Stack profile refresh flag must be a boolean.");
  }
  return {
    projectId: readId(request.projectId, "Project id"),
    grantHandle: readOpaque(request.grantHandle, "Grant handle"),
    ...(request.refresh === undefined ? {} : { refresh: request.refresh }),
  };
}

export function parseStackProfileResponse(value: unknown): StackProfileResponse {
  const response = assertRecord(value, "Stack profile response");
  if (response.status === "denied") {
    assertKeys(response, ["status"], "Denied stack profile response");
    return { status: "denied" };
  }
  if (response.status === "unavailable") {
    assertKeys(response, ["status", "reason"], "Unavailable stack profile response");
    return { status: "unavailable", reason: readSafeText(response.reason, "Stack profile unavailable reason", 240) };
  }
  if (response.status === "ready") {
    assertKeys(response, ["status", "profile", "cached"], "Ready stack profile response");
    if (typeof response.cached !== "boolean") throw new Error("Stack profile cached flag must be a boolean.");
    return { status: "ready", profile: parseStackProfile(response.profile), cached: response.cached };
  }
  throw new Error("Stack profile response status is invalid.");
}
