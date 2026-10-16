import { parsePluginDescription } from "./plugin-description-ipc";
import type { Harness } from "../domain/harness-projection";
import type { EntryKind } from "../domain/project-source-registry";

export type ImportArtifactRequest = Readonly<{
  kind: "import-artifact";
  source: Readonly<{ kind: EntryKind; id: string; grantHandle: string }>;
  relativePath: string;
  target: Readonly<
    { packageId: string } | { newPackageName: string; description: string; projectTo?: readonly Harness[] }
  >;
}>;

export type RestoreImportRequest = Readonly<{ kind: "restore-import"; operationId: string }>;
export type ImportOperationRequest = ImportArtifactRequest | RestoreImportRequest;

export type PathsResponse = Readonly<{
  marketplace?: Readonly<{ displayRoot: string }>;
  store: Readonly<{ displayRoot: string }>;
}>;

type RecordValue = Record<string, unknown>;

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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`${label} is malformed.`);
  return id;
}

function readOpaque(value: unknown, label: string): string {
  const text = readText(value, label);
  if (
    text.includes("/") ||
    text.includes("\\") ||
    text.includes("..") ||
    /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(text)
  )
    throw new Error(`${label} must be opaque.`);
  return text;
}

function readRelativePath(value: unknown): string {
  const path = readText(value, "Imported relative path").replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(path) || path.startsWith("/") || /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(path))
    throw new Error("Imported relative path is unsafe.");
  return path;
}

function readDisplayRoot(value: unknown): string {
  const root = readText(value, "Display root");
  const parts = root.startsWith("/") ? root.slice(1).split("/") : root.split("/");
  if (
    (root !== "~" && !root.startsWith("~/") && !root.startsWith("/")) ||
    root.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(root) ||
    (root !== "/" && parts.some((part) => part === ".." || part === "." || part === ""))
  )
    throw new Error("Display root must be an absolute or home-relative path without traversal or control characters.");
  return root;
}

export function parsePreviewImportRequest(value: unknown): ImportArtifactRequest {
  const request = assertRecord(value, "Import preview request");
  assertKeys(request, ["kind", "source", "relativePath", "target"], "Import preview request");
  if (request.kind !== "import-artifact") throw new Error("Operation kind is invalid.");
  const source = assertRecord(request.source, "Import source");
  assertKeys(source, ["kind", "id", "grantHandle"], "Import source");
  if (source.kind !== "project" && source.kind !== "source") throw new Error("Entry kind is invalid.");
  const target = assertRecord(request.target, "Import target");
  assertKeys(target, ["packageId", "newPackageName", "description", "projectTo"], "Import target");
  const hasPackage = target.packageId !== undefined;
  const hasNewPackage = target.newPackageName !== undefined;
  if (hasPackage === hasNewPackage) throw new Error("Import target must select one package destination.");
  if (hasPackage && (target.projectTo !== undefined || target.description !== undefined))
    throw new Error("Package targets cannot request harness projections.");
  let projectTo: readonly Harness[] | undefined;
  if (target.projectTo !== undefined) {
    if (!Array.isArray(target.projectTo)) throw new Error("Import projection targets must be an array.");
    const values = target.projectTo.map((harness) => {
      if (harness !== "claude-code" && harness !== "codex") throw new Error("Import projection harness is invalid.");
      return harness;
    });
    if (new Set(values).size !== values.length) throw new Error("Import projection targets must be unique.");
    projectTo = values;
  }
  return {
    kind: "import-artifact",
    source: {
      kind: source.kind,
      id: readId(source.id, "Source id"),
      grantHandle: readOpaque(source.grantHandle, "Grant handle"),
    },
    relativePath: readRelativePath(request.relativePath),
    target: hasPackage
      ? { packageId: readRelativeTarget(target.packageId) }
      : {
          newPackageName: readText(target.newPackageName, "New package name"),
          description: parsePluginDescription(target.description),
          ...(projectTo ? { projectTo } : {}),
        },
  };
}

function readRelativeTarget(value: unknown): string {
  const path = readText(value, "Package path").replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Package path must be a safe relative path.");
  }
  return path;
}

export function parsePreviewRestoreRequest(value: unknown): RestoreImportRequest {
  const request = assertRecord(value, "Restore preview request");
  assertKeys(request, ["kind", "operationId"], "Restore preview request");
  if (request.kind !== "restore-import") throw new Error("Operation kind is invalid.");
  return { kind: "restore-import", operationId: readOpaque(request.operationId, "Operation id") };
}

export function parseImportOperationRequest(value: unknown): ImportOperationRequest {
  const record = assertRecord(value, "Import operation request");
  return record.kind === "restore-import" ? parsePreviewRestoreRequest(record) : parsePreviewImportRequest(record);
}

export function parsePathsResponse(value: unknown): PathsResponse {
  const response = assertRecord(value, "Operations paths response");
  assertKeys(response, ["marketplace", "store"], "Operations paths response");
  const store = assertRecord(response.store, "Operations store path");
  assertKeys(store, ["displayRoot"], "Operations store path");
  const marketplace =
    response.marketplace === undefined ? undefined : assertRecord(response.marketplace, "Marketplace path");
  if (marketplace) assertKeys(marketplace, ["displayRoot"], "Marketplace path");
  return {
    ...(marketplace ? { marketplace: { displayRoot: readDisplayRoot(marketplace.displayRoot) } } : {}),
    store: { displayRoot: readDisplayRoot(store.displayRoot) },
  };
}
