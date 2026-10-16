// The honest fallback for any OS without its own `Platform` implementation. Every read
// returns an honest empty result instead of throwing, so the Activity view can still show the
// harness evidence (sessions read from transcripts, which are OS-neutral) with an empty
// process tree; every action throws `PlatformUnsupportedError`, since there is no honest no-op
// for "stop this process" or "open a terminal here."
import { resolve } from "node:path";

import {
  PlatformUnsupportedError,
  type ListeningPort,
  type Platform,
  type PlatformSignal,
  type RawProcess,
} from "./platform";

function unsupportedAction(what: string): never {
  throw new PlatformUnsupportedError(`${what} is not available on this platform.`);
}

// Windows addresses a gateway socket by named pipe, not a filesystem path; computed for
// honesty (Settings · Agents can display it) but never dialled — no unsupported platform
// starts the agent gateway today.
function pipeEndpoint(userDataPath: string): string {
  const canonical = resolve(userDataPath, "omni", "agent.sock");
  const hash = Buffer.from(canonical).toString("base64url").slice(-24);
  return `\\\\.\\pipe\\omni-${hash}`;
}

function endpointFor(id: Platform["id"]): (userDataPath: string) => string {
  return id === "win32" ? pipeEndpoint : (userDataPath) => resolve(userDataPath, "omni", "agent.sock");
}

export function createUnsupportedPlatform(id: Exclude<Platform["id"], "darwin">): Platform {
  return {
    id,
    supported: false,
    processes: {
      list: async (): Promise<readonly RawProcess[]> => [],
      workingDirectories: async (): Promise<ReadonlyMap<number, string>> => new Map(),
      signal: async (_pid: number, _action: PlatformSignal): Promise<void> => unsupportedAction("Stopping a process"),
      isAlive: (): boolean => false,
      // A read, not an action: an honest empty result rather than a thrown error, matching
      // `list()`/`workingDirectories()` above.
      listeningPorts: async (): Promise<readonly ListeningPort[]> => [],
      renice: async (_pid: number, _nice: number): Promise<void> => unsupportedAction("Changing process priority"),
    },
    terminal: {
      open: async (_cwd: string): Promise<void> => unsupportedAction("Opening a terminal"),
    },
    gateway: {
      endpoint: endpointFor(id),
      secure: async (): Promise<void> => {
        // No socket is ever bound on an unsupported platform, so there is nothing to secure.
      },
    },
  };
}
