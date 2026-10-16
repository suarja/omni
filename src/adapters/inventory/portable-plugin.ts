import type { InventoryDiagnostic } from "../../domain/inventory";
import type { InventoryFilesystemPort } from "../../ports/inventory";
import { diagnostic } from "./shared";
import { readJson } from "./source-layout-utils";

const PORTABLE_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function addDiagnosticOnce(
  diagnostics: InventoryDiagnostic[],
  path: string,
  code: InventoryDiagnostic["code"],
  message: string,
): void {
  if (diagnostics.some((item) => item.location === path && item.code === code && item.message === message)) return;
  diagnostics.push(diagnostic(path, code, message));
}

function safeName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return (
    Boolean(text) &&
    text.length <= 120 &&
    !CONTROL_CHARACTERS.test(text) &&
    !/[\\/]/u.test(text) &&
    text !== "." &&
    text !== ".."
  );
}

function hasOnlyDefaultSkills(value: unknown): boolean {
  if (value === undefined) return true;
  const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!paths || paths.some((path) => typeof path !== "string")) return false;
  return (paths as string[]).every((path) => {
    const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return normalized === "skills";
  });
}

export async function supportsPortablePluginManifest(
  filesystem: InventoryFilesystemPort,
  path: string,
  diagnostics: InventoryDiagnostic[],
): Promise<boolean> {
  const manifest = await readJson(filesystem, path, diagnostics);
  if (!manifest) return false;
  if (manifest.$schema !== PORTABLE_SCHEMA) {
    addDiagnosticOnce(diagnostics, path, "unsupported", "The portable plugin schema is unsupported.");
    return false;
  }
  if (!safeName(manifest.name)) {
    addDiagnosticOnce(diagnostics, path, "malformed", "The portable plugin name is malformed.");
    return false;
  }
  if (!hasOnlyDefaultSkills(manifest.skills)) {
    addDiagnosticOnce(diagnostics, path, "unsupported", "The portable plugin declares unsupported skill paths.");
  }
  return true;
}
