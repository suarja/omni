import type { InventoryDiagnostic, ObservedPackageFormat, RemotePackageDeclaration } from "../../domain/inventory";
import type { InventoryDirectoryEntry, InventoryFilesystemPort } from "../../ports/inventory";
import { diagnostic, errorDiagnostic } from "./shared";

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function join(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}
export function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return undefined;
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return normalized;
}
export function packageName(relativeRoot: string, manifest: Record<string, unknown> | undefined): string {
  const name = manifest?.name;
  if (typeof name === "string" && name.trim() && !/[\r\n]/.test(name)) return name.trim();
  return relativeRoot.split("/").at(-1) ?? relativeRoot;
}
export function parseManifestShape(
  path: string,
  value: unknown,
  diagnostics: InventoryDiagnostic[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    diagnostics.push(diagnostic(path, "malformed", "The marketplace manifest is malformed."));
    return undefined;
  }
  return value as Record<string, unknown>;
}
export type PackageDeclaration = Readonly<{
  path: string;
  description?: string;
  version?: string;
}>;

export type ManifestDeclarations = Readonly<{
  local: readonly PackageDeclaration[];
  remote: readonly RemotePackageDeclaration[];
}>;

export function optionalManifestText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

// Remote declarations come from other people's manifests: a description longer than the
// snapshot allows (public marketplaces write paragraphs) is clipped, never a reason to fail
// the observation; control characters are dropped.
export function remoteDisplayText(value: unknown, limit = 200): string | undefined {
  const text = optionalManifestText(value)
    ?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .trim();
  if (!text) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function packageRootPath(relativeRoot: string): string {
  return relativeRoot === "root" ? "" : relativeRoot;
}

export async function readmePath(
  filesystem: InventoryFilesystemPort,
  relativeRoot: string,
  diagnostics: InventoryDiagnostic[],
): Promise<string | undefined> {
  for (const name of ["README.md", "readme.md", "Readme.md"]) {
    const path = join(packageRootPath(relativeRoot), name);
    try {
      const location = await filesystem.lstat(path);
      if (location.type === "file" || location.type === "symlink") return path;
    } catch (error: unknown) {
      const issue = errorDiagnostic(path, error);
      if (issue && issue.code !== "unsupported") diagnostics.push(issue);
    }
  }
  return undefined;
}

export async function readJson(
  filesystem: InventoryFilesystemPort,
  path: string,
  diagnostics: InventoryDiagnostic[],
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await filesystem.readText(path);
  } catch (error: unknown) {
    const issue = errorDiagnostic(path, error);
    if (issue) diagnostics.push(issue);
    return undefined;
  }
  try {
    return parseManifestShape(path, JSON.parse(text), diagnostics);
  } catch {
    diagnostics.push(diagnostic(path, "malformed", "The marketplace manifest is malformed."));
    return undefined;
  }
}

export function remoteNameFromLocator(locator: string): string {
  const value = locator
    .replace(/^github:/, "")
    .replace(/^url:/, "")
    .replace(/^git:/, "");
  const withoutRef = value.split("@")[0] ?? value;
  const segment = withoutRef.split(/[/?#]/).filter(Boolean).at(-1);
  return segment || value;
}
export function isRemoteString(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("github:") || /^[A-Za-z][A-Za-z\d+.-]*:\/\/\S+$/u.test(trimmed);
}
