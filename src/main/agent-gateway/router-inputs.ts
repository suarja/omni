import { basename } from "node:path";
import { homedir } from "node:os";

import type { WriteSkillFile } from "../../shared/operations-write-skill-ipc";

export function fail(message: string, code = "request-failed"): Error & Readonly<{ code: string }> {
  const error = new Error(message);
  error.name = "AgentGatewayError";
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error as Error & Readonly<{ code: string }>;
}

export function empty(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value as object).length)
    throw fail(`${label} accepts no parameters.`);
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw fail(`${label} has an unexpected field.`);
}

export function text(value: unknown, label: string, max = 240): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(value)
  )
    throw fail(`${label} is invalid.`);
  return value.trim();
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw fail(`${label} must be a boolean.`);
  return value;
}

export function id(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw fail(`${label} is invalid.`);
  return result;
}

export function path(value: unknown, label: string): string {
  const result = text(value, label, 512).replaceAll("\\", "/");
  if (
    result.startsWith("/") ||
    /^[A-Za-z]:\//u.test(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw fail(`${label} must be relative.`);
  return result;
}

export function skillBody(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 * 1024 || /[\u0000\u007f-\u009f]/u.test(value))
    throw fail("Skill content is invalid.");
  return value;
}

export function skillFiles(value: unknown, label: string): readonly WriteSkillFile[] {
  if (!Array.isArray(value)) throw fail(`${label} files must be an array.`);
  return value.map((item) => {
    const file = object(item, `${label} file`);
    keys(file, ["path", "content"], `${label} file`);
    return { path: text(file.path, `${label} file path`, 512), content: skillBody(file.content) };
  });
}

export function skillFolderName(value: unknown): string {
  const raw = text(value, "Skill asset", 512).replaceAll("\\", "/");
  return (
    raw
      .split("/")
      .at(-1)
      ?.replace(/^skill:/u, "") ?? raw
  );
}

export function displayCwd(cwd: string): string {
  const normalized = cwd.replaceAll("\\", "/");
  const home = homedir().replaceAll("\\", "/").replace(/\/$/u, "");
  if (normalized === home) return "~";
  if (normalized.startsWith(`${home}/`)) return `~${normalized.slice(home.length)}`;
  return normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized) ? basename(normalized) : normalized;
}
