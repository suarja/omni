// The one place in `src/main` allowed to read `process.platform` for a service decision (the
// Electron window chrome in `index.ts` and the `O_NOFOLLOW_ANY` filesystem flag in
// `src/adapters/inventory/local-filesystem.ts` are UI and filesystem concerns, not services,
// and are left as-is). Every consumer receives a `Platform` by injection instead of branching
// on the OS itself.
import { createDarwinPlatform } from "./darwin";
import { createUnsupportedPlatform } from "./unsupported";
import type { Platform } from "./platform";

export type { ListeningPort, Platform, PlatformSignal, ProcessState, RawProcess } from "./platform";
export { PlatformUnsupportedError } from "./platform";

export function createPlatform(id: NodeJS.Platform = process.platform): Platform {
  if (id === "darwin") return createDarwinPlatform();
  return createUnsupportedPlatform(id === "win32" ? "win32" : "linux");
}
