import { isBuiltin } from "node:module";
import { join } from "node:path";

/** @returns {{ iconSource: string, iconDestination: string, obsoleteIcon: string, plistEntries: Record<string, string> }} */
export function applicationBrandingPlan(sourceRoot, app) {
  return {
    iconSource: join(sourceRoot, "resources/brand/Omni.icns"),
    iconDestination: join(app, "Contents/Resources/Omni.icns"),
    obsoleteIcon: join(app, "Contents/Resources/electron.icns"),
    plistEntries: {
      CFBundleDisplayName: "Omni",
      CFBundleName: "Omni",
      CFBundleExecutable: "Omni",
      CFBundleIconFile: "Omni",
    },
  };
}

export function assertCleanSnapshot(status) {
  if (status.split("\n").some((line) => line && !line.startsWith("?? "))) {
    throw new Error("Release packaging requires a clean tracked snapshot. Commit the approved slice first.");
  }
}

export function assertSafeDestination(path, exists) {
  if (exists) throw new Error(`Release destination already exists: ${path}. Choose a new directory.`);
}

export function inspectRuntimeImports(source) {
  const imports = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  return [...new Set(imports.filter((name) => name !== "electron" && !name.startsWith(".") && !isBuiltin(name)))];
}
