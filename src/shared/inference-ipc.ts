// IPC contract for the inference core: `run` for the three first commands (Suggest, Explain,
// Summarize), and `dryRun` (Brief 35b) — the exact request the provider would send for a
// command's deterministic input, without a key and without sending it.

import type { CatalogueEntryView } from "./catalogue-ipc";
import { assertKeys, assertRecord } from "./operations-ipc-parser-utils";

export type TaskId = "suggest-adapt" | "explain" | "summarize";
export const INFERENCE_IPC_CHANNELS = {
  run: "omni:inference:run",
  dryRun: "omni:inference:dry-run",
} as const;

export type InferenceProviderId = "none" | "pi" | "agent";
export type InferenceOutcomeStatus = "ok" | "unavailable" | "refused" | "failed" | "invalid-output";

export type InferenceSuggestItemView = Readonly<{
  entry: CatalogueEntryView;
  score: number;
  matchedTags: readonly string[];
  adapted: boolean;
  reason?: string;
}>;

/** `language` = the UI language: the adapted reasons are written in it (default English). */
export type InferenceSuggestRunRequest = Readonly<{
  command: "suggest";
  projectId: string;
  limit?: number;
  language?: "en" | "fr";
  bypassCache?: boolean;
}>;
export type InferenceSuggestRunResponse = Readonly<{
  command: "suggest";
  intelligence: InferenceOutcomeStatus;
  reason?: string;
  items: readonly InferenceSuggestItemView[];
}>;

export type InferenceExplainRunRequest = Readonly<{
  command: "explain";
  findingKind: string;
  left: string;
  right: string;
}>;
export type InferenceExplainRunResponse = Readonly<{
  command: "explain";
  intelligence: InferenceOutcomeStatus;
  reason?: string;
  explanation?: string;
  keep?: "left" | "right" | "either" | "unknown";
}>;

export type InferenceSummarizeRunRequest = Readonly<{
  command: "summarize";
  kind: "session" | "receipt";
  lines: readonly string[];
}>;
export type InferenceSummarizeRunResponse = Readonly<{
  command: "summarize";
  intelligence: InferenceOutcomeStatus;
  reason?: string;
  sentence?: string;
}>;

export type InferenceRunRequest =
  InferenceSuggestRunRequest | InferenceExplainRunRequest | InferenceSummarizeRunRequest;
export type InferenceRunResponse =
  InferenceSuggestRunResponse | InferenceExplainRunResponse | InferenceSummarizeRunResponse;

/** The dry run's suggest input (Brief 35b): the same shape `suggest-adapt`'s task takes — ranked candidates already picked, not a project id (no ranking happens here). */
export type InferenceDryRunProfileTag = Readonly<{ id: string; label: string; evidenceCount: number }>;
export type InferenceDryRunCandidate = Readonly<{
  ownerRepo: string;
  skill: string;
  name: string;
  description?: string;
  why: readonly string[];
}>;
export type InferenceDryRunSuggestInput = Readonly<{
  profileTags: readonly InferenceDryRunProfileTag[];
  candidates: readonly InferenceDryRunCandidate[];
}>;

export type InferenceDryRunRequest =
  | Readonly<{ command: "suggest"; input: InferenceDryRunSuggestInput }>
  | Readonly<{ command: "explain"; input: Readonly<{ findingKind: string; left: string; right: string }> }>
  | Readonly<{
      command: "summarize";
      input: Readonly<{ kind: "session" | "receipt"; lines: readonly string[] }>;
    }>;

/** No key, never sent — model, cached system blocks, the user turn, and the tool's JSON Schema. */
export type InferenceDryRunResponse = Readonly<{
  modelId: string;
  provider: string;
  system: string;
  userContent: string;
  toolSchema: Readonly<Record<string, unknown>>;
}>;

export interface InferenceDesktopApi {
  runInferenceCommand(request: InferenceRunRequest): Promise<InferenceRunResponse>;
  dryRunInference(request: InferenceDryRunRequest): Promise<InferenceDryRunResponse>;
}

const MAX_KEY_LENGTH = 4_000;
const MAX_FINDING_KIND_LENGTH = 64;
const MAX_SIDE_LENGTH = 4_000;
const MAX_LINE_LENGTH = 300;
const MAX_LINES = 20;
const MAX_SUGGEST_LIMIT = 20;
const MAX_REASON_LENGTH = 160;
const MAX_DRY_RUN_PROFILE_TAGS = 20;
const MAX_DRY_RUN_CANDIDATES = 20;
const MAX_OWNER_REPO_LENGTH = 200;
const MAX_CANDIDATE_NAME_LENGTH = 200;
const MAX_CANDIDATE_DESCRIPTION_LENGTH = 2_000;
const MAX_WHY_ITEMS = 10;
const MAX_WHY_LENGTH = 100;
const MAX_TAG_TEXT_LENGTH = 100;

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function readBoundedText(value: unknown, label: string, maxLength: number): string {
  const text = readText(value, label);
  if (text.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  return text;
}

function readId(value: unknown, label: string): string {
  const id = readText(value, label).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id)) throw new Error(`${label} is malformed.`);
  return id;
}

function readOutcomeStatus(value: unknown): InferenceOutcomeStatus {
  if (
    value !== "ok" &&
    value !== "unavailable" &&
    value !== "refused" &&
    value !== "failed" &&
    value !== "invalid-output"
  )
    throw new Error("Inference outcome status is invalid.");
  return value;
}

function readOptionalReason(value: unknown): string | undefined {
  return value === undefined ? undefined : readBoundedText(value, "Inference reason", 500);
}

export function parseEmptyInferenceRequest(value: unknown): void {
  const request = assertRecord(value, "Inference request");
  assertKeys(request, [], "Inference request");
}

export function parseInferenceRunRequest(value: unknown): InferenceRunRequest {
  const request = assertRecord(value, "Inference run request");
  if (request.command === "suggest") {
    assertKeys(request, ["command", "projectId", "limit", "language", "bypassCache"], "Inference run request");
    const limit = request.limit;
    if (request.language !== undefined && request.language !== "en" && request.language !== "fr")
      throw new Error("Suggest language is invalid.");
    if (request.bypassCache !== undefined && typeof request.bypassCache !== "boolean")
      throw new Error("Suggest cache bypass is invalid.");
    if (
      limit !== undefined &&
      (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_SUGGEST_LIMIT)
    )
      throw new Error(`Suggest limit must be an integer between 1 and ${MAX_SUGGEST_LIMIT}.`);
    return {
      command: "suggest",
      projectId: readId(request.projectId, "Project id"),
      ...(limit === undefined ? {} : { limit }),
      ...(request.language === undefined ? {} : { language: request.language }),
      ...(request.bypassCache === undefined ? {} : { bypassCache: request.bypassCache }),
    };
  }
  if (request.command === "explain") {
    assertKeys(request, ["command", "findingKind", "left", "right"], "Inference run request");
    return {
      command: "explain",
      findingKind: readBoundedText(request.findingKind, "Finding kind", MAX_FINDING_KIND_LENGTH),
      left: readBoundedText(request.left, "Finding left side", MAX_SIDE_LENGTH),
      right: readBoundedText(request.right, "Finding right side", MAX_SIDE_LENGTH),
    };
  }
  if (request.command === "summarize") {
    assertKeys(request, ["command", "kind", "lines"], "Inference run request");
    if (request.kind !== "session" && request.kind !== "receipt")
      throw new Error('Summarize kind must be "session" or "receipt".');
    if (!Array.isArray(request.lines)) throw new Error("Summarize lines must be an array.");
    if (request.lines.length > MAX_LINES) throw new Error(`Summarize lines must be at most ${MAX_LINES}.`);
    return {
      command: "summarize",
      kind: request.kind,
      lines: request.lines.map((line) => readBoundedText(line, "Summarize line", MAX_LINE_LENGTH)),
    };
  }
  throw new Error("Inference run request command is invalid.");
}

function parseSuggestEntryView(value: unknown): CatalogueEntryView {
  const entry = assertRecord(value, "Inference suggest entry");
  assertKeys(
    entry,
    [
      "source",
      "ownerRepo",
      "skill",
      "name",
      "description",
      "hasSkillMd",
      "tags",
      "installs",
      "official",
      "packageName",
    ],
    "Inference suggest entry",
  );
  if (entry.source !== "skills.sh" && entry.source !== "marketplace")
    throw new Error("Inference suggest entry source is invalid.");
  if (typeof entry.hasSkillMd !== "boolean") throw new Error("Inference suggest entry hasSkillMd must be a boolean.");
  if (typeof entry.official !== "boolean") throw new Error("Inference suggest entry official must be a boolean.");
  if (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === "string"))
    throw new Error("Inference suggest entry tags must be an array of strings.");
  if (typeof entry.installs !== "number") throw new Error("Inference suggest entry installs must be a number.");
  return {
    source: entry.source,
    ownerRepo: readText(entry.ownerRepo, "Inference suggest entry ownerRepo"),
    skill: readId(entry.skill, "Inference suggest entry skill"),
    name: readText(entry.name, "Inference suggest entry name"),
    ...optionalBoundedField("description", entry.description, "Inference suggest entry description", 2_000),
    hasSkillMd: entry.hasSkillMd,
    tags: entry.tags,
    installs: entry.installs,
    official: entry.official,
    ...optionalBoundedField("packageName", entry.packageName, "Inference suggest entry packageName", 200),
  };
}

function parseSuggestItem(value: unknown): InferenceSuggestItemView {
  const item = assertRecord(value, "Inference suggest item");
  assertKeys(item, ["entry", "score", "matchedTags", "adapted", "reason"], "Inference suggest item");
  if (typeof item.score !== "number") throw new Error("Inference suggest item score must be a number.");
  if (!Array.isArray(item.matchedTags) || !item.matchedTags.every((tag) => typeof tag === "string"))
    throw new Error("Inference suggest item matchedTags must be an array of strings.");
  if (typeof item.adapted !== "boolean") throw new Error("Inference suggest item adapted must be a boolean.");
  return {
    entry: parseSuggestEntryView(item.entry),
    score: item.score,
    matchedTags: item.matchedTags,
    adapted: item.adapted,
    ...optionalBoundedField("reason", item.reason, "Inference suggest item reason", MAX_REASON_LENGTH),
  };
}

export function parseInferenceRunResponse(value: unknown): InferenceRunResponse {
  const response = assertRecord(value, "Inference run response");
  if (response.command === "suggest") {
    assertKeys(response, ["command", "intelligence", "reason", "items"], "Inference run response");
    if (!Array.isArray(response.items)) throw new Error("Inference suggest response items must be an array.");
    return {
      command: "suggest",
      intelligence: readOutcomeStatus(response.intelligence),
      reason: readOptionalReason(response.reason),
      items: response.items.map(parseSuggestItem),
    };
  }
  if (response.command === "explain") {
    assertKeys(response, ["command", "intelligence", "reason", "explanation", "keep"], "Inference run response");
    if (
      response.keep !== undefined &&
      response.keep !== "left" &&
      response.keep !== "right" &&
      response.keep !== "either" &&
      response.keep !== "unknown"
    )
      throw new Error("Inference explain response keep is invalid.");
    return {
      command: "explain",
      intelligence: readOutcomeStatus(response.intelligence),
      reason: readOptionalReason(response.reason),
      ...optionalBoundedField("explanation", response.explanation, "Explanation", 400),
      ...(response.keep === undefined ? {} : { keep: response.keep }),
    };
  }
  if (response.command === "summarize") {
    assertKeys(response, ["command", "intelligence", "reason", "sentence"], "Inference run response");
    return {
      command: "summarize",
      intelligence: readOutcomeStatus(response.intelligence),
      reason: readOptionalReason(response.reason),
      ...optionalBoundedField("sentence", response.sentence, "Sentence", 200),
    };
  }
  throw new Error("Inference run response command is invalid.");
}

/** `{}` for an absent optional field, or `{ [key]: <bounded text> }` — one line at each call site. */
function optionalBoundedField(key: string, value: unknown, label: string, maxLength: number): Record<string, string> {
  return value === undefined ? {} : { [key]: readBoundedText(value, label, maxLength) };
}

function parseDryRunProfileTag(value: unknown): InferenceDryRunProfileTag {
  const tag = assertRecord(value, "Dry-run profile tag");
  assertKeys(tag, ["id", "label", "evidenceCount"], "Dry-run profile tag");
  if (typeof tag.evidenceCount !== "number") throw new Error("Dry-run profile tag evidenceCount must be a number.");
  return {
    id: readBoundedText(tag.id, "Dry-run profile tag id", MAX_TAG_TEXT_LENGTH),
    label: readBoundedText(tag.label, "Dry-run profile tag label", MAX_TAG_TEXT_LENGTH),
    evidenceCount: tag.evidenceCount,
  };
}

function parseDryRunCandidate(value: unknown): InferenceDryRunCandidate {
  const candidate = assertRecord(value, "Dry-run candidate");
  assertKeys(candidate, ["ownerRepo", "skill", "name", "description", "why"], "Dry-run candidate");
  if (!Array.isArray(candidate.why) || candidate.why.length > MAX_WHY_ITEMS)
    throw new Error(`Dry-run candidate why must be an array of at most ${MAX_WHY_ITEMS} strings.`);
  return {
    ownerRepo: readBoundedText(candidate.ownerRepo, "Dry-run candidate ownerRepo", MAX_OWNER_REPO_LENGTH),
    skill: readId(candidate.skill, "Dry-run candidate skill"),
    name: readBoundedText(candidate.name, "Dry-run candidate name", MAX_CANDIDATE_NAME_LENGTH),
    ...optionalBoundedField(
      "description",
      candidate.description,
      "Dry-run candidate description",
      MAX_CANDIDATE_DESCRIPTION_LENGTH,
    ),
    why: candidate.why.map((entry) => readBoundedText(entry, "Dry-run candidate why entry", MAX_WHY_LENGTH)),
  };
}

export function parseInferenceDryRunRequest(value: unknown): InferenceDryRunRequest {
  const request = assertRecord(value, "Inference dry-run request");
  if (request.command === "suggest") {
    assertKeys(request, ["command", "input"], "Inference dry-run request");
    const input = assertRecord(request.input, "Inference dry-run suggest input");
    assertKeys(input, ["profileTags", "candidates"], "Inference dry-run suggest input");
    if (!Array.isArray(input.profileTags) || input.profileTags.length > MAX_DRY_RUN_PROFILE_TAGS)
      throw new Error(`Dry-run profileTags must be an array of at most ${MAX_DRY_RUN_PROFILE_TAGS}.`);
    if (!Array.isArray(input.candidates) || input.candidates.length > MAX_DRY_RUN_CANDIDATES)
      throw new Error(`Dry-run candidates must be an array of at most ${MAX_DRY_RUN_CANDIDATES}.`);
    return {
      command: "suggest",
      input: {
        profileTags: input.profileTags.map(parseDryRunProfileTag),
        candidates: input.candidates.map(parseDryRunCandidate),
      },
    };
  }
  if (request.command === "explain") {
    assertKeys(request, ["command", "input"], "Inference dry-run request");
    const input = assertRecord(request.input, "Inference dry-run explain input");
    assertKeys(input, ["findingKind", "left", "right"], "Inference dry-run explain input");
    return {
      command: "explain",
      input: {
        findingKind: readBoundedText(input.findingKind, "Dry-run finding kind", MAX_FINDING_KIND_LENGTH),
        left: readBoundedText(input.left, "Dry-run left side", MAX_SIDE_LENGTH),
        right: readBoundedText(input.right, "Dry-run right side", MAX_SIDE_LENGTH),
      },
    };
  }
  if (request.command === "summarize") {
    assertKeys(request, ["command", "input"], "Inference dry-run request");
    const input = assertRecord(request.input, "Inference dry-run summarize input");
    assertKeys(input, ["kind", "lines"], "Inference dry-run summarize input");
    if (input.kind !== "session" && input.kind !== "receipt")
      throw new Error('Dry-run summarize kind must be "session" or "receipt".');
    if (!Array.isArray(input.lines) || input.lines.length > MAX_LINES)
      throw new Error(`Dry-run summarize lines must be at most ${MAX_LINES}.`);
    return {
      command: "summarize",
      input: {
        kind: input.kind,
        lines: input.lines.map((line) => readBoundedText(line, "Dry-run summarize line", MAX_LINE_LENGTH)),
      },
    };
  }
  throw new Error("Inference dry-run request command is invalid.");
}

export function parseInferenceDryRunResponse(value: unknown): InferenceDryRunResponse {
  const response = assertRecord(value, "Inference dry-run response");
  assertKeys(response, ["modelId", "provider", "system", "userContent", "toolSchema"], "Inference dry-run response");
  const toolSchema = assertRecord(response.toolSchema, "Inference dry-run response toolSchema");
  return {
    modelId: readId(response.modelId, "Inference dry-run response model id"),
    provider: readText(response.provider, "Inference dry-run response provider"),
    system: readText(response.system, "Inference dry-run response system"),
    userContent: readText(response.userContent, "Inference dry-run response userContent"),
    toolSchema,
  };
}
