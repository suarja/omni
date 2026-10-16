// The platform seam: one interface for everything OS-specific in the main process. A new
// operating system is a new implementation of `Platform`, never a `process.platform` branch
// spread across features (see CONTRIBUTING.md "Platform support").
//
// `RawProcess`'s field names match `PsProcess` (`../activity-processes.ts`) exactly, on
// purpose: the BSD `ps` parser's output already *is* a `RawProcess`, with no mapping layer
// in between.
// The BSD `ps` STAT column's first letter, normalised to a small closed set: anything Omni
// does not specifically recognise (idle, uninterruptible sleep, locked, …) reads as "other"
// rather than being guessed at.
export type ProcessState = "running" | "sleeping" | "stopped" | "zombie" | "other";

export type RawProcess = Readonly<{
  pid: number;
  ppid: number;
  cpuPercent: number;
  elapsedSeconds: number;
  rssMb: number;
  command: string;
  startedAt?: number;
  cwd?: string;
  state?: ProcessState;
}>;

export type ListeningPort = Readonly<{ pid: number; port: number }>;

export type PlatformSignal = "stop" | "kill" | "pause" | "resume";

export type Platform = Readonly<{
  id: "darwin" | "linux" | "win32";
  // False for `unsupported`: every method still returns honest, typed results instead of
  // throwing, except the actions (`signal`, `terminal.open`, `renice`) which have no honest
  // no-op and throw `PlatformUnsupportedError`.
  supported: boolean;
  processes: Readonly<{
    list(): Promise<readonly RawProcess[]>;
    workingDirectories(pids: readonly number[]): Promise<ReadonlyMap<number, string>>;
    signal(pid: number, action: PlatformSignal): Promise<void>;
    isAlive(pid: number): boolean;
    // Listening TCP ports for the given pids, fetched on demand (never eagerly for a whole
    // snapshot): honest empty array when unsupported or when nothing is listening.
    listeningPorts(pids: readonly number[]): Promise<readonly ListeningPort[]>;
    renice(pid: number, nice: number): Promise<void>;
  }>;
  terminal: Readonly<{ open(cwd: string): Promise<void> }>;
  gateway: Readonly<{ endpoint(userDataPath: string): string; secure(path: string): Promise<void> }>;
}>;

export class PlatformUnsupportedError extends Error {
  readonly code = "platform-unsupported";

  constructor(message: string) {
    super(message);
    this.name = "PlatformUnsupportedError";
  }
}
