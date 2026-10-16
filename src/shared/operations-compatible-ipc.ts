import type { CompatibilityReport } from "../domain/compatibility-report";

export type { CompatibilityArtifact, CompatibilityPackage, CompatibilityReport } from "../domain/compatibility-report";

export type PreviewCompatibleRequest = Readonly<{
  kind: "make-compatible";
  sourceId: string;
  packageId?: string;
  harness: "claude-code" | "codex";
  keepUpdates?: readonly string[];
}>;

type RecordValue = Record<string, unknown>;
const MAX_TEXT = 240;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_TEXT ||
    /[\r\n]/u.test(value) ||
    /(?:^|[\s(])(?:\/|[A-Za-z]:[\\/])/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function id(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function relativePath(value: unknown, label: string): string {
  const result = text(value, label).replaceAll("\\", "/");
  if (
    result.startsWith("/") ||
    /^[A-Za-z]:\//u.test(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} is unsafe.`);
  }
  return result;
}

export function parsePreviewCompatibleRequest(value: unknown): PreviewCompatibleRequest {
  const request = record(value, "Compatible preview request");
  keys(request, ["kind", "sourceId", "packageId", "harness", "keepUpdates"], "Compatible preview request");
  if (request.kind !== "make-compatible") throw new Error("Operation kind is invalid.");
  if (request.harness !== "claude-code" && request.harness !== "codex") {
    throw new Error("Compatibility harness is invalid.");
  }
  const keepUpdates = request.keepUpdates === undefined ? undefined : request.keepUpdates;
  if (
    keepUpdates !== undefined &&
    (!Array.isArray(keepUpdates) || keepUpdates.some((path) => typeof path !== "string"))
  ) {
    throw new Error("Compatibility update paths are invalid.");
  }
  const paths = keepUpdates?.map((path) => relativePath(path, "Compatibility update path"));
  if (paths && new Set(paths).size !== paths.length) throw new Error("Compatibility update paths must be unique.");
  return {
    kind: "make-compatible",
    sourceId: id(request.sourceId, "Source id"),
    ...(request.packageId === undefined ? {} : { packageId: relativePath(request.packageId, "Package id") }),
    harness: request.harness,
    ...(paths ? { keepUpdates: paths } : {}),
  };
}

function reportPath(value: unknown, label: string): string {
  return relativePath(value, label);
}

function parseArtifact(value: unknown): CompatibilityReport["packages"][number]["artifacts"][number] {
  const artifact = record(value, "Compatibility artifact");
  keys(artifact, ["path", "kind", "status", "reason"], "Compatibility artifact");
  const kinds = [
    "skill",
    "instruction",
    "rule",
    "command",
    "agent",
    "hook",
    "mcp-config",
    "plugin-manifest",
    "marketplace-manifest",
    "unknown",
  ];
  const statuses = ["transposable", "partial", "not-transposable"];
  if (!kinds.includes(String(artifact.kind)) || !statuses.includes(String(artifact.status))) {
    throw new Error("Compatibility artifact is invalid.");
  }
  return {
    path: reportPath(artifact.path, "Compatibility artifact path"),
    kind: artifact.kind as CompatibilityReport["packages"][number]["artifacts"][number]["kind"],
    status: artifact.status as CompatibilityReport["packages"][number]["artifacts"][number]["status"],
    ...(artifact.reason === undefined ? {} : { reason: text(artifact.reason, "Compatibility artifact reason") }),
  };
}

function parsePackage(value: unknown): CompatibilityReport["packages"][number] {
  const packageInfo = record(value, "Compatibility package");
  keys(
    packageInfo,
    ["packageId", "name", "path", "verdict", "reason", "alreadyCompatible", "artifacts"],
    "Compatibility package",
  );
  const verdicts = ["ready", "partial", "remote", "blocked"];
  if (!verdicts.includes(String(packageInfo.verdict)) || !Array.isArray(packageInfo.artifacts)) {
    throw new Error("Compatibility package is invalid.");
  }
  if (packageInfo.alreadyCompatible !== undefined && typeof packageInfo.alreadyCompatible !== "boolean") {
    throw new Error("Compatibility flag is invalid.");
  }
  return {
    packageId: reportPath(packageInfo.packageId, "Compatibility package id"),
    name: text(packageInfo.name, "Compatibility package name"),
    path: reportPath(packageInfo.path, "Compatibility package path"),
    verdict: packageInfo.verdict as CompatibilityReport["packages"][number]["verdict"],
    ...(packageInfo.reason === undefined ? {} : { reason: text(packageInfo.reason, "Compatibility package reason") }),
    ...(packageInfo.alreadyCompatible === undefined ? {} : { alreadyCompatible: packageInfo.alreadyCompatible }),
    artifacts: packageInfo.artifacts.map(parseArtifact),
  };
}

export function parseCompatibilityReport(value: unknown): CompatibilityReport {
  const report = record(value, "Compatibility report");
  keys(report, ["harness", "packages"], "Compatibility report");
  if (report.harness !== "claude-code" && report.harness !== "codex") {
    throw new Error("Compatibility harness is invalid.");
  }
  if (!Array.isArray(report.packages)) throw new Error("Compatibility packages are invalid.");
  return { harness: report.harness, packages: report.packages.map(parsePackage) };
}
