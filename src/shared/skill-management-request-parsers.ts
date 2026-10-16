import type {
  SkillActor,
  SkillManagementApplyRequest,
  SkillManagementPreviewRequest,
  SkillManagementRefreshRequest,
  SkillManagementResultRequest,
  SkillIntent,
} from "./skill-management-ipc";
import { parseSkillIntent } from "./skill-intent-parser";

type RecordValue = Record<string, unknown>;

export function parseSkillManagementPreviewRequest(value: unknown): SkillManagementPreviewRequest {
  const request = record(value, "Skill preview request");
  keys(request, ["intent", "requestId"], "Skill preview request");
  return {
    intent: parseSkillIntent(request.intent) as SkillIntent,
    ...(request.requestId === undefined ? {} : { requestId: id(request.requestId, "Request id") }),
  };
}

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function id(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /[\\/\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new Error(`${label} is invalid.`);
  return value.trim();
}

export function parseSkillActor(value: unknown): SkillActor {
  const actor = record(value, "Skill actor");
  if (actor.kind === "desktop") {
    keys(actor, ["kind", "automatic"], "Desktop actor");
    if (actor.automatic !== undefined && actor.automatic !== true) throw new Error("Automatic actor is invalid.");
    return { kind: "desktop", ...(actor.automatic ? { automatic: true } : {}) };
  }
  if (actor.kind === "mcp") {
    keys(actor, ["kind", "requestId", "harness", "sessionName"], "MCP actor");
    const knownHarness = actor.harness === undefined ? undefined : actor.harness;
    if (knownHarness !== undefined && knownHarness !== "claude-code" && knownHarness !== "codex")
      throw new Error("MCP actor harness is invalid.");
    return {
      kind: "mcp",
      ...(actor.requestId === undefined ? {} : { requestId: id(actor.requestId, "Request id") }),
      ...(knownHarness === undefined
        ? {}
        : { harness: knownHarness as Extract<SkillActor, { kind: "mcp" }>["harness"] }),
      ...(actor.sessionName === undefined ? {} : { sessionName: id(actor.sessionName, "Session name") }),
    };
  }
  throw new Error("Skill actor kind is invalid.");
}

export function parseSkillManagementRefreshRequest(value: unknown): SkillManagementRefreshRequest {
  const request = record(value, "Skill refresh request");
  keys(request, ["intentId", "requestId"], "Skill refresh request");
  return {
    intentId: id(request.intentId, "Intent id"),
    ...(request.requestId === undefined ? {} : { requestId: id(request.requestId, "Request id") }),
  };
}

export function parseSkillManagementApplyRequest(value: unknown): SkillManagementApplyRequest {
  const request = record(value, "Skill apply request");
  keys(request, ["intentId", "effectFingerprint", "requestId"], "Skill apply request");
  if (typeof request.effectFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(request.effectFingerprint))
    throw new Error("Skill effect fingerprint is invalid.");
  return {
    intentId: id(request.intentId, "Intent id"),
    effectFingerprint: request.effectFingerprint,
    ...(request.requestId === undefined ? {} : { requestId: id(request.requestId, "Request id") }),
  };
}

export function parseSkillManagementResultRequest(value: unknown): SkillManagementResultRequest {
  const request = record(value, "Skill result request");
  keys(request, ["intentId"], "Skill result request");
  return { intentId: id(request.intentId, "Intent id") };
}
