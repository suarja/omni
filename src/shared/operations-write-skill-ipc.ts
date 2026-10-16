import { parsePluginDescription } from "./plugin-description-ipc";
import type { AgentHarness } from "./agents-ipc";

export type WriteSkillFile = Readonly<{ path: string; content: string; encoding?: "base64" }>;
export type SkillAgentProvenance = Readonly<{
  harness: AgentHarness;
  sessionName?: string;
  requestedAt: string;
}>;
export type WriteSkillRequest = Readonly<{
  kind: "write-skill";
  sourceId: string;
  packageId?: string;
  newPackage?: Readonly<{ name: string; description: string }>;
  mode: "create" | "update";
  folderName: string;
  files: readonly WriteSkillFile[];
  replaceFolder?: boolean;
  reason?: string;
  agent?: SkillAgentProvenance;
}>;

const MAX_FILES = 32;
const MAX_BYTES = 256 * 1024;

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}
function content(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000\u007f-\u009f]/u.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}
function binaryContent(value: unknown, label: string): string {
  const maximumEncodedLength = Math.ceil(MAX_BYTES / 3) * 4;
  if (
    typeof value !== "string" ||
    value.length > maximumEncodedLength ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  )
    throw new Error(`${label} must be canonical base64.`);
  if (Buffer.from(value, "base64").toString("base64") !== value) throw new Error(`${label} must be canonical base64.`);
  return value;
}
function safePath(value: unknown, label: string): string {
  const path = text(value, label, 512).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${label} must be a safe relative path.`);
  return path;
}
function id(value: unknown, label: string): string {
  return text(value, label, 128).trim();
}
function iso(value: unknown, label: string): string {
  const timestamp = text(value, label, 40).trim();
  if (new Date(timestamp).toISOString() !== timestamp) throw new Error(`${label} is invalid.`);
  return timestamp;
}

export function parseWriteSkillRequest(value: unknown): WriteSkillRequest {
  const request = record(value, "Write skill request");
  keys(
    request,
    ["kind", "sourceId", "packageId", "newPackage", "mode", "folderName", "files", "replaceFolder", "reason", "agent"],
    "Write skill request",
  );
  if (request.kind !== "write-skill") throw new Error("Operation kind is invalid.");
  if (request.mode !== "create" && request.mode !== "update") throw new Error("Write skill mode is invalid.");
  if ((request.packageId !== undefined) === (request.newPackage !== undefined))
    throw new Error("Choose exactly one existing package or new plugin.");
  const newPackage = request.newPackage === undefined ? undefined : record(request.newPackage, "New plugin");
  if (newPackage) {
    keys(newPackage, ["name", "description"], "New plugin");
    if (request.mode !== "create") throw new Error("A new plugin requires create mode.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(text(newPackage.name, "New plugin name", 64)))
      throw new Error("New plugin name must use lowercase letters and hyphens.");
  }
  const filesValue = request.files;
  if (!Array.isArray(filesValue) || filesValue.length === 0 || filesValue.length > MAX_FILES)
    throw new Error("Write skill files are invalid.");
  let totalBytes = 0;
  const files = filesValue.map((value) => {
    const file = record(value, "Write skill file");
    keys(file, ["path", "content", "contentBase64", "encoding"], "Write skill file");
    if (file.encoding !== undefined && file.encoding !== "base64")
      throw new Error("Write skill file encoding is invalid.");
    const binaryValue = file.contentBase64 ?? (file.encoding === "base64" ? file.content : undefined);
    if (
      (file.content === undefined && file.contentBase64 === undefined) ||
      (file.content !== undefined && file.contentBase64 !== undefined) ||
      (file.encoding === "base64" && file.contentBase64 !== undefined)
    )
      throw new Error("Write skill file must contain exactly one content encoding.");
    const path = safePath(file.path, "Write skill file path");
    if (binaryValue !== undefined) {
      const fileContent = binaryContent(binaryValue, "Write skill file content");
      totalBytes += Buffer.from(fileContent, "base64").byteLength;
      return { path, content: fileContent, encoding: "base64" as const };
    }
    const fileContent = content(file.content, "Write skill file content", MAX_BYTES);
    totalBytes += Buffer.byteLength(fileContent, "utf8");
    return { path, content: fileContent };
  });
  if (totalBytes > MAX_BYTES) throw new Error("Write skill request is too large.");
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("Write skill files must be unique.");
  const agent = request.agent === undefined ? undefined : record(request.agent, "Skill agent provenance");
  if (agent) {
    keys(agent, ["harness", "sessionName", "requestedAt"], "Skill agent provenance");
    if (agent.harness !== "claude-code" && agent.harness !== "codex")
      throw new Error("Skill agent harness is invalid.");
  }
  const folderName = text(request.folderName, "Skill folder name", 64).trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(folderName)) throw new Error("Skill folder name is invalid.");
  return {
    kind: "write-skill",
    sourceId: id(request.sourceId, "Source id"),
    ...(newPackage
      ? { newPackage: { name: newPackage.name as string, description: parsePluginDescription(newPackage.description) } }
      : { packageId: safePath(request.packageId, "Package id") }),
    mode: request.mode,
    folderName,
    files,
    ...(request.replaceFolder === undefined ? {} : { replaceFolder: request.replaceFolder === true }),
    ...(request.reason === undefined ? {} : { reason: text(request.reason, "Reason", 1024).trim() }),
    ...(agent
      ? {
          agent: {
            harness: agent.harness as AgentHarness,
            ...(agent.sessionName === undefined
              ? {}
              : { sessionName: text(agent.sessionName, "Session name", 120).trim() }),
            requestedAt: iso(agent.requestedAt, "Requested at"),
          },
        }
      : {}),
  };
}

export function writeSkillFileBytes(file: WriteSkillFile): Uint8Array {
  return file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
}

export function writeSkillFileText(file: WriteSkillFile): string | undefined {
  return file.encoding === "base64" ? undefined : file.content;
}
