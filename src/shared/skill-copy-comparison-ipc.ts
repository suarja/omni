import type { SkillLocationKey, SkillTreeRead } from "../domain/skill-reconciliation/types";
import type { SkillCopyFilePresentation, SkillCopyFileSummary } from "../domain/skill-reconciliation/comparison";
import { parseSkillLocationKey, parseSkillRevision } from "../domain/skill-reconciliation/validation";

export const SKILL_COPY_COMPARISON_CHANNEL = "omni:skill-reconciliation:compare-copies";

export type SkillCopyComparisonRequest = Readonly<{
  projectId: string;
  grantHandle: string;
  skillId: string;
  a: SkillLocationKey;
  b: SkillLocationKey;
  filePath?: string;
}>;

export type SkillCopyComparisonTreeRead = SkillTreeRead;
export type SkillCopyLocationReadDto = Readonly<{ location: SkillLocationKey; read: SkillCopyComparisonTreeRead }>;
export type SkillCopyComparisonEvidence = Readonly<{
  source: "unknown";
  base: "unknown";
  relationship: "declared" | "observed-equivalence" | "individual";
}>;

export type SkillCopyComparisonResponse =
  | Readonly<{
      status: "ready";
      projectId: string;
      skillId: string;
      a: SkillCopyLocationReadDto;
      b: SkillCopyLocationReadDto;
      files: readonly SkillCopyFileSummary[];
      selectedPath?: string;
      presentation?: SkillCopyFilePresentation;
      evidence: SkillCopyComparisonEvidence;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "grant" | "root" | "store" | "membership" | "read";
      a?: SkillCopyLocationReadDto;
      b?: SkillCopyLocationReadDto;
    }>;

export interface SkillCopyComparisonDesktopApi {
  compareSkillCopies(request: SkillCopyComparisonRequest): Promise<SkillCopyComparisonResponse>;
}

type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function text(value: unknown, label: string, maximum = 240): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = text(value, label, 1024);
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return path;
}

export function parseSkillCopyComparisonRequest(value: unknown): SkillCopyComparisonRequest {
  const input = record(value, "Skill copy comparison request");
  keys(input, ["projectId", "grantHandle", "skillId", "a", "b", "filePath"], "Skill copy comparison request");
  const projectId = text(input.projectId, "Project id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(projectId)) throw new Error("Project id is malformed.");
  const grantHandle = text(input.grantHandle, "Grant handle", 256);
  if (grantHandle.includes("/") || grantHandle.includes("\\") || grantHandle.includes("..")) {
    throw new Error("Grant handle must be opaque.");
  }
  const skillId = text(input.skillId, "Logical skill id", 64);
  if (!UUID.test(skillId)) throw new Error("Logical skill id must be a UUID.");
  const a = parseSkillLocationKey(input.a);
  const b = parseSkillLocationKey(input.b);
  if (a.projectId !== projectId || b.projectId !== projectId) {
    throw new Error("Skill comparison locations must belong to the project.");
  }
  if (JSON.stringify(a) === JSON.stringify(b)) throw new Error("Skill comparison locations must be distinct.");
  return {
    projectId,
    grantHandle,
    skillId,
    a,
    b,
    ...(input.filePath === undefined ? {} : { filePath: safeRelativePath(input.filePath, "Selected file path") }),
  };
}

function parseTreeRead(value: unknown): SkillCopyComparisonTreeRead {
  const input = record(value, "Skill tree read");
  if (input.status === "complete") {
    keys(input, ["status", "revision"], "Skill tree read");
    return { status: "complete", revision: parseSkillRevision(input.revision) };
  }
  keys(input, ["status", "reason"], "Skill tree read");
  if (
    input.status !== "unavailable" ||
    !["missing", "denied", "unsafe-tree", "limit", "changed-during-read", "io"].includes(String(input.reason))
  ) {
    throw new Error("Skill tree read status is invalid.");
  }
  return { status: "unavailable", reason: input.reason as Extract<SkillTreeRead, { status: "unavailable" }>["reason"] };
}

function parseLocationRead(value: unknown): SkillCopyLocationReadDto {
  const input = record(value, "Skill copy location read");
  keys(input, ["location", "read"], "Skill copy location read");
  return { location: parseSkillLocationKey(input.location), read: parseTreeRead(input.read) };
}

function parseFileSide(value: unknown, label: string): SkillCopyFileSummary["left"] {
  if (value === undefined) return undefined;
  const input = record(value, label);
  keys(input, ["hash", "byteLength"], label);
  if (
    typeof input.hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.hash) ||
    typeof input.byteLength !== "number" ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0 ||
    input.byteLength > 1024 * 1024
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return { hash: input.hash, byteLength: input.byteLength };
}

function expectedFileSummaries(a: SkillTreeRead, b: SkillTreeRead): readonly SkillCopyFileSummary[] {
  if (a.status !== "complete" || b.status !== "complete") return [];
  const aFiles = new Map(a.revision.files.map((file) => [file.path, file]));
  const bFiles = new Map(b.revision.files.map((file) => [file.path, file]));
  return [...new Set([...aFiles.keys(), ...bFiles.keys()])]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((path) => {
      const left = aFiles.get(path);
      const right = bFiles.get(path);
      const change: SkillCopyFileSummary["change"] = !left
        ? "add"
        : !right
          ? "delete"
          : left.hash === right.hash && left.byteLength === right.byteLength
            ? "unchanged"
            : "change";
      return {
        path,
        change,
        ...(left ? { left: { hash: left.hash, byteLength: left.byteLength } } : {}),
        ...(right ? { right: { hash: right.hash, byteLength: right.byteLength } } : {}),
      };
    });
}

function parseFileSummary(value: unknown): SkillCopyFileSummary {
  const input = record(value, "Skill copy file summary");
  keys(input, ["path", "change", "left", "right"], "Skill copy file summary");
  if (!["add", "change", "delete", "unchanged"].includes(String(input.change))) {
    throw new Error("Skill copy file change is invalid.");
  }
  const path = safeRelativePath(input.path, "Skill copy file path");
  const left = parseFileSide(input.left, "Skill copy file A metadata");
  const right = parseFileSide(input.right, "Skill copy file B metadata");
  if ((input.change === "add" && (left || !right)) || (input.change === "delete" && (!left || right))) {
    throw new Error("Skill copy file sides do not match its change.");
  }
  if ((input.change === "change" || input.change === "unchanged") && (!left || !right)) {
    throw new Error("Skill copy file sides are incomplete.");
  }
  return {
    path,
    change: input.change as SkillCopyFileSummary["change"],
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
  };
}

function parsePresentation(value: unknown): SkillCopyFilePresentation {
  const input = record(value, "Skill copy presentation");
  if (input.presentation === "text") {
    keys(input, ["presentation", "diff", "truncated", "byteDifferenceNotice"], "Skill copy presentation");
    if (
      typeof input.diff !== "string" ||
      Buffer.byteLength(input.diff, "utf8") > 64 * 1024 ||
      typeof input.truncated !== "boolean" ||
      (input.byteDifferenceNotice !== undefined && typeof input.byteDifferenceNotice !== "boolean")
    ) {
      throw new Error("Skill copy diff is invalid or exceeds its limit.");
    }
    return {
      presentation: "text",
      diff: input.diff,
      truncated: input.truncated,
      ...(input.byteDifferenceNotice === true ? { byteDifferenceNotice: true } : {}),
    };
  }
  keys(input, ["presentation", "summary"], "Skill copy presentation");
  if (input.presentation !== "binary" && input.presentation !== "too-large" && input.presentation !== "unchanged") {
    throw new Error("Skill copy presentation is invalid.");
  }
  if (input.summary !== undefined && typeof input.summary !== "string") {
    throw new Error("Skill copy summary is invalid.");
  }
  return {
    presentation: input.presentation,
    ...(input.summary === undefined ? {} : { summary: text(input.summary, "Skill copy summary", 240) }),
  };
}

export function parseSkillCopyComparisonResponse(value: unknown): SkillCopyComparisonResponse {
  const input = record(value, "Skill copy comparison response");
  if (input.status === "unavailable") {
    keys(input, ["status", "reason", "a", "b"], "Skill copy comparison response");
    if (!["grant", "root", "store", "membership", "read"].includes(String(input.reason))) {
      throw new Error("Skill comparison unavailable reason is invalid.");
    }
    return {
      status: "unavailable",
      reason: input.reason as Extract<SkillCopyComparisonResponse, { status: "unavailable" }>["reason"],
      ...(input.a === undefined ? {} : { a: parseLocationRead(input.a) }),
      ...(input.b === undefined ? {} : { b: parseLocationRead(input.b) }),
    };
  }
  keys(
    input,
    ["status", "projectId", "skillId", "a", "b", "files", "selectedPath", "presentation", "evidence"],
    "Skill copy comparison response",
  );
  if (input.status !== "ready" || !Array.isArray(input.files) || input.files.length > 1024) {
    throw new Error("Skill copy comparison response is invalid.");
  }
  const projectId = text(input.projectId, "Project id", 128);
  const skillId = text(input.skillId, "Logical skill id", 64);
  if (!UUID.test(skillId)) throw new Error("Logical skill id must be a UUID.");
  const a = parseLocationRead(input.a);
  const b = parseLocationRead(input.b);
  if (
    a.location.projectId !== projectId ||
    b.location.projectId !== projectId ||
    JSON.stringify(a.location) === JSON.stringify(b.location) ||
    a.read.status !== "complete" ||
    b.read.status !== "complete"
  ) {
    throw new Error("Skill comparison locations are inconsistent or unavailable.");
  }
  const files = input.files.map(parseFileSummary);
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("Skill comparison file paths must be unique.");
  if (JSON.stringify(files) !== JSON.stringify(expectedFileSummaries(a.read, b.read))) {
    throw new Error("Skill comparison file summaries do not match the side revisions.");
  }
  const selectedPath =
    input.selectedPath === undefined ? undefined : safeRelativePath(input.selectedPath, "Selected file path");
  if (selectedPath !== undefined && !files.some((file) => file.path === selectedPath)) {
    throw new Error("Selected skill comparison file is missing from the file list.");
  }
  const presentation = input.presentation === undefined ? undefined : parsePresentation(input.presentation);
  if ((selectedPath === undefined) !== (presentation === undefined)) {
    throw new Error("Selected skill comparison file and presentation must be paired.");
  }
  const evidenceInput = record(input.evidence, "Skill comparison evidence");
  keys(evidenceInput, ["source", "base", "relationship"], "Skill comparison evidence");
  if (
    evidenceInput.source !== "unknown" ||
    evidenceInput.base !== "unknown" ||
    !["declared", "observed-equivalence", "individual"].includes(String(evidenceInput.relationship))
  ) {
    throw new Error("Skill comparison evidence is invalid.");
  }
  return {
    status: "ready",
    projectId,
    skillId,
    a,
    b,
    files,
    ...(selectedPath === undefined ? {} : { selectedPath }),
    ...(presentation === undefined ? {} : { presentation }),
    evidence: {
      source: "unknown",
      base: "unknown",
      relationship: evidenceInput.relationship as SkillCopyComparisonEvidence["relationship"],
    },
  };
}
