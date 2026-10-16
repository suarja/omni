// A shared in-memory `Platform` stub, used wherever a test exercised the old
// `processRunner`/`cwdRunner` seams directly: the snapshot, actions and gateway suites all
// build their fixtures on top of this rather than each hand-rolling process/cwd/signal fakes.
import type { ListeningPort, Platform, PlatformSignal, RawProcess } from "../../src/main/platform/platform";

export type PlatformStubOptions = Readonly<{
  id?: Platform["id"];
  supported?: boolean;
  // A plain array for a fixed process list, or a function when a test needs the list to
  // reflect state that changes after the stub is built (for example a simulation process
  // spawned mid-test).
  processes?: readonly RawProcess[] | (() => readonly RawProcess[]);
  cwdByPid?: ReadonlyMap<number, string>;
  alivePids?: ReadonlySet<number>;
  onSignal?: (pid: number, action: PlatformSignal) => void;
  onTerminalOpen?: (cwd: string) => void;
  gatewayEndpoint?: string;
  onSecure?: (path: string) => void;
  listeningPorts?: readonly ListeningPort[];
  onRenice?: (pid: number, nice: number) => void;
}>;

export function createPlatformStub(options: PlatformStubOptions = {}): Platform {
  const processesOf = (): readonly RawProcess[] =>
    typeof options.processes === "function" ? options.processes() : (options.processes ?? []);
  const alive = new Set<number>(options.alivePids ?? processesOf().map((process) => process.pid));
  return {
    id: options.id ?? "darwin",
    supported: options.supported ?? true,
    processes: {
      list: async () => processesOf(),
      workingDirectories: async (pids) => {
        const cwds = options.cwdByPid ?? new Map<number, string>();
        return new Map(pids.flatMap((pid) => (cwds.has(pid) ? [[pid, cwds.get(pid) as string] as const] : [])));
      },
      signal: async (pid, action) => {
        options.onSignal?.(pid, action);
        if (action === "stop" || action === "kill") alive.delete(pid);
      },
      isAlive: (pid) => alive.has(pid),
      listeningPorts: async (pids) => (options.listeningPorts ?? []).filter((port) => pids.includes(port.pid)),
      renice: async (pid, nice) => {
        options.onRenice?.(pid, nice);
      },
    },
    terminal: {
      open: async (cwd) => {
        options.onTerminalOpen?.(cwd);
      },
    },
    gateway: {
      endpoint: () => options.gatewayEndpoint ?? "/tmp/omni-platform-stub/agent.sock",
      secure: async (path) => {
        options.onSecure?.(path);
      },
    },
  };
}
