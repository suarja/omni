import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export type ResourceOptions = Readonly<{
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
}>;

function runtimeApp(): { isPackaged?: boolean; getAppPath?: () => string } | undefined {
  try {
    return (require("electron") as { app?: { isPackaged?: boolean; getAppPath?: () => string } }).app;
  } catch {
    return undefined;
  }
}

export function resourcesArePackaged(options: ResourceOptions = {}): boolean {
  return options.isPackaged ?? Boolean(runtimeApp()?.isPackaged);
}

export function resolveResource(relativePath: string, options: ResourceOptions = {}): string {
  const app = runtimeApp();
  const packaged = resourcesArePackaged(options);
  const root = packaged
    ? (options.appPath ?? app?.getAppPath?.() ?? join(options.resourcesPath ?? process.resourcesPath, "app"))
    : (options.appPath ?? app?.getAppPath?.() ?? process.cwd());
  return join(root, relativePath);
}
