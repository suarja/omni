import { parseProjectSkillIntent } from "./project-skills-ipc";
import { isExternalSkillIntent, parseExternalSkillIntent } from "./external-skill-intents";
import type { HarnessId } from "../domain/harness-targets";
import { parseWriteSkillRequest } from "./operations-write-skill-ipc";
import { parseSkillPropagationIntent } from "./skill-propagation-ipc";
import { parseSkillReconciliationRequest } from "./skill-reconciliation-request";
import type { SkillIntent } from "./skill-management-ipc";

type RecordValue = Record<string, unknown>;
const HARNESSES: readonly HarnessId[] = ["claude-code", "codex", "cursor"];

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

function relativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`${label} is invalid.`);
  const path = value.trim().replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${label} must be a safe relative path.`);
  return path;
}

function harness(value: unknown): HarnessId {
  if (!HARNESSES.includes(value as HarnessId)) throw new Error("Harness id is invalid.");
  return value as HarnessId;
}

function unique(values: readonly string[], label: string): void {
  if (!values.length || new Set(values).size !== values.length)
    throw new Error(`${label} must be non-empty and unique.`);
}

export function parseSkillIntent(value: unknown): SkillIntent {
  const intent = record(value, "Skill intent");
  if (isExternalSkillIntent({ kind: String(intent.kind) })) return parseExternalSkillIntent(intent);
  if (intent.kind === "project-skill") return parseProjectSkillIntent(intent);
  if (intent.kind === "write") {
    keys(intent, ["kind", "request"], "Skill write intent");
    return { kind: "write", request: parseWriteSkillRequest(intent.request) };
  }
  if (intent.kind === "assign") {
    keys(intent, ["kind", "sourceId", "packageId", "artifactPath", "targets"], "Skill assignment intent");
    if (!Array.isArray(intent.targets)) throw new Error("Skill assignment targets are invalid.");
    const targets = intent.targets.map((value) => {
      const target = record(value, "Skill assignment target");
      keys(target, ["projectId", "harnessIds"], "Skill assignment target");
      if (!Array.isArray(target.harnessIds)) throw new Error("Skill assignment harnesses are invalid.");
      const harnessIds = target.harnessIds.map(harness);
      unique(harnessIds, "Skill assignment harnesses");
      return { projectId: id(target.projectId, "Project id"), harnessIds };
    });
    unique(
      targets.map((target) => target.projectId),
      "Skill assignment projects",
    );
    return {
      kind: "assign",
      sourceId: id(intent.sourceId, "Source id"),
      packageId: relativePath(intent.packageId, "Package id"),
      ...(intent.artifactPath === undefined
        ? {}
        : { artifactPath: relativePath(intent.artifactPath, "Artifact path") }),
      targets,
    };
  }
  if (intent.kind === "remove") {
    keys(intent, ["kind", "bindingIds"], "Skill removal intent");
    if (!Array.isArray(intent.bindingIds)) throw new Error("Skill binding ids are invalid.");
    const bindingIds = intent.bindingIds.map((value) => id(value, "Binding id"));
    unique(bindingIds, "Skill binding ids");
    return { kind: "remove", bindingIds };
  }
  if (intent.kind === "restore") {
    keys(intent, ["kind", "operationId"], "Skill restore intent");
    return { kind: "restore", operationId: id(intent.operationId, "Operation id") };
  }
  if (intent.kind === "reconcile") {
    keys(intent, ["kind", "request"], "Skill reconciliation intent");
    return { kind: "reconcile", request: parseSkillReconciliationRequest(intent.request) };
  }
  if (intent.kind === "update-and-maintain" || intent.kind === "maintain-current")
    return parseSkillPropagationIntent(intent);
  throw new Error("Skill intent kind is invalid.");
}
