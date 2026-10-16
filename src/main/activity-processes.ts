import { basename } from "node:path";
import { homedir } from "node:os";

import { activityHarnessAdapters } from "../adapters/activity";
import { describeProcess } from "../domain/process-names";
import {
  PROCESS_FULL_COMMAND_MAX_LENGTH,
  type AgentName,
  type AgentProcess,
  type ProcessFlag,
} from "../shared/activity-ipc";
import { displayPath } from "./activity-paths";
import type { ListeningPort, ProcessState, RawProcess } from "./platform/platform";

// The BSD `ps` parser's output *is* a `RawProcess` — the platform interface's field names
// were chosen to match this module, not the other way around, so there is no mapping layer
// between what `ps` produces and what the `Platform` interface promises.
export type PsProcess = RawProcess;

export type ProcessCwdReader = (pids: readonly number[]) => Promise<string>;
export type ProcessAttributionOptions = Readonly<{
  rootSessionIds?: ReadonlyMap<number, string>;
  conversationSessionIds?: ReadonlyMap<number, string>;
  conversationNames?: ReadonlyMap<number, string>;
}>;

type AgentTreeProcess = PsProcess &
  Readonly<{
    agent: AgentName;
    depth: number;
    rootPid: number;
    sessionId?: string;
  }>;

const HOME_DIR = homedir();

function parseElapsed(value: string): number {
  const [dayPart, timePart] = value.includes("-") ? value.split("-", 2) : ["0", value];
  const days = Number(dayPart) || 0;
  const parts = (timePart ?? "0:0:0").split(":").map(Number);
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function parseLstart(value: string): number | undefined {
  const timestamp = Date.parse(value.trim());
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

// The BSD `ps` STAT column's first letter is the only part Omni reads: modifiers ("s" session
// leader, "+" foreground, "<" high priority, …) that follow it are display noise for this
// purpose. Anything not explicitly one of R/S/T/Z reads as "other" rather than being guessed at.
function parseState(stat: string): ProcessState {
  const letter = stat.trim().charAt(0).toUpperCase();
  if (letter === "R") return "running";
  if (letter === "S") return "sleeping";
  if (letter === "T") return "stopped";
  if (letter === "Z") return "zombie";
  return "other";
}

function parseModernLine(line: string): PsProcess | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.{24})\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuPercent: Number(match[3]),
    elapsedSeconds: parseElapsed(match[4]),
    startedAt: parseLstart(match[5]),
    rssMb: Number(match[6]) / 1024,
    state: parseState(match[7]),
    command: match[8].trim(),
  };
}

function parseLegacyLine(line: string): PsProcess | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\d+)\s+(.+)$/u.exec(line);
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuPercent: Number(match[3]),
    elapsedSeconds: parseElapsed(match[4]),
    rssMb: Number(match[5]) / 1024,
    command: match[6].trim(),
  };
}

export function parsePsOutput(output: string): PsProcess[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const process = parseModernLine(line) ?? parseLegacyLine(line);
    return process ? [process] : [];
  });
}

function executable(command: string): string {
  return basename(command.trim().split(/\s+/u)[0] ?? "").toLowerCase();
}

export function isExcludedProcessCommand(command: string): boolean {
  return (
    /--type=/iu.test(command) ||
    /\bHelper\b/iu.test(command) ||
    /crashpad/iu.test(command) ||
    /\((?:Service|Renderer|GPU|Plugin)\)/u.test(command) ||
    /\/Contents\/Helpers\/disclaimer\s+--(?:\s|$)/u.test(command) ||
    /codex-code-mode-host/iu.test(command) ||
    /Codex Framework\.framework/iu.test(command)
  );
}

function isSimulationCommand(command: string): boolean {
  return /omni-sim-runaway/iu.test(command);
}

function identify(command: string, pid: number, omniPid: number): AgentName | undefined {
  if (pid === omniPid) return "omni";
  if (isSimulationCommand(command)) return "simulation";
  if (isExcludedProcessCommand(command)) return undefined;
  if (activityHarnessAdapters.some((adapter) => adapter.isRoot(command))) {
    return activityHarnessAdapters.find((adapter) => adapter.isRoot(command))?.harness;
  }
  const executableName = executable(command);
  if (executableName === "cursor-agent") return "cursor";
  if (executableName === "opencode") return "opencode";
  return undefined;
}

export function findActivityRoots(processes: readonly PsProcess[], omniPid: number): PsProcess[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  return processes.filter((process) => {
    const agent = identify(process.command, process.pid, omniPid);
    const parent = byPid.get(process.ppid);
    const parentAgent = parent ? identify(parent.command, parent.pid, omniPid) : undefined;
    return agent !== undefined && agent !== "omni" && (agent === "simulation" || parentAgent === undefined);
  });
}

function descendantsByParent(processes: readonly PsProcess[]): Map<number, PsProcess[]> {
  const children = new Map<number, PsProcess[]>();
  for (const process of processes) {
    children.set(process.ppid, [...(children.get(process.ppid) ?? []), process]);
  }
  return children;
}

function collectTree(
  root: PsProcess,
  byParent: Map<number, PsProcess[]>,
  agent: AgentName,
  omniPid: number,
  options: ProcessAttributionOptions,
): AgentTreeProcess[] {
  const result: AgentTreeProcess[] = [];
  const visit = (
    process: PsProcess,
    currentAgent: AgentName,
    depth: number,
    rootPid: number,
    inheritedSessionId: string | undefined,
  ): void => {
    if (isExcludedProcessCommand(process.command) && !isSimulationCommand(process.command)) return;
    const nestedAgent = identify(process.command, process.pid, omniPid);
    const sessionId = options.conversationSessionIds?.get(process.pid) ?? inheritedSessionId;
    result.push({
      ...process,
      agent: currentAgent,
      depth,
      rootPid,
      ...(sessionId ? { sessionId } : {}),
    });
    for (const child of byParent.get(process.pid) ?? []) {
      const childAgent = identify(child.command, child.pid, omniPid) ?? currentAgent;
      if (currentAgent === "omni" || childAgent === "omni") continue;
      const childSessionId =
        options.rootSessionIds?.get(child.pid) ?? (childAgent === currentAgent ? sessionId : undefined);
      visit(
        child,
        childAgent,
        childAgent === currentAgent ? depth + 1 : 0,
        childAgent === currentAgent ? rootPid : child.pid,
        childSessionId,
      );
    }
  };
  visit(root, agent, 0, root.pid, options.rootSessionIds?.get(root.pid));
  return result;
}

function normalizedCommand(command: string): string {
  return describeProcess(command).toLowerCase().replace(/\s+/gu, " ");
}

function isRunner(command: string): boolean {
  const directRunner = /(?:vitest|jest|tsc|esbuild|vite|webpack)/iu.test(command);
  const scriptRunner = /(?:pnpm|npm)\s+(?:run\s+)?(?:test|build|check|typecheck|lint|watch)/iu.test(command);
  return directRunner || scriptRunner;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function flagsFor(process: AgentTreeProcess, tree: readonly AgentTreeProcess[]): ProcessFlag[] {
  const hasChildren = tree.some((candidate) => candidate.ppid === process.pid);
  const flags: ProcessFlag[] = [];
  if (!hasChildren && process.cpuPercent >= 90 && process.elapsedSeconds >= 120 && isRunner(process.command)) {
    flags.push("runaway");
  }
  // Two agent sessions legitimately share one command line; only duplicated runners are a signal.
  const sameCommand = (candidate: AgentTreeProcess): boolean =>
    normalizedCommand(candidate.command) === normalizedCommand(process.command);
  if (isRunner(process.command) && tree.filter(sameCommand).length >= 2) flags.push("duplicate");
  if (process.ppid === 1 && isRunner(process.command)) flags.push("orphan");
  return flags;
}

export function parseLsofCwdOutput(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | undefined;
  let isCwd = false;
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      isCwd = false;
    } else if (line === "fcwd") {
      isCwd = true;
    } else if (line.startsWith("n") && pid !== undefined && isCwd) {
      result.set(pid, line.slice(1));
      isCwd = false;
    }
  }
  return result;
}

// `lsof -iTCP -sTCP:LISTEN -P -n -p <pids>` tabular output: header row "COMMAND PID USER FD
// TYPE DEVICE SIZE/OFF NODE NAME" then one row per socket, NAME ending in "host:port (LISTEN)".
// `-P -n` keep the port numeric and the host unresolved, so the trailing `:port (LISTEN)` shape
// is stable regardless of hostname length.
// One entry per (pid, port): a socket bound on IPv4 and IPv6 appears twice in lsof.
export function parseLsofListenPorts(output: string): ListeningPort[] {
  const seen = new Set<string>();
  const result: ListeningPort[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim() || line.startsWith("COMMAND")) continue;
    const match = /^\S+\s+(\d+)\s+.*:(\d+)\s*\(LISTEN\)\s*$/u.exec(line);
    if (!match) continue;
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ pid: Number(match[1]), port: Number(match[2]) });
  }
  return result.sort((left, right) => left.pid - right.pid || left.port - right.port);
}

export async function readProcessCwds(pids: readonly number[], runner: ProcessCwdReader): Promise<Map<number, string>> {
  if (!pids.length) return new Map();
  try {
    return parseLsofCwdOutput(await runner(pids));
  } catch {
    return new Map();
  }
}

export function attachProcessCwds(processes: readonly PsProcess[], cwdByPid: ReadonlyMap<number, string>): PsProcess[] {
  return processes.map((process) => ({
    ...process,
    ...(cwdByPid.get(process.pid) ? { cwd: cwdByPid.get(process.pid) } : {}),
  }));
}

export function attributeProcesses(
  processes: readonly PsProcess[],
  omniPid: number,
  options: ProcessAttributionOptions = {},
): AgentProcess[] {
  const byParent = descendantsByParent(processes);
  const roots = findActivityRoots(processes, omniPid);
  const trees = roots.flatMap((root) => {
    const agent = identify(root.command, root.pid, omniPid);
    return agent ? collectTree(root, byParent, agent, omniPid, options) : [];
  });
  const treeByAgent = new Map<AgentName, AgentTreeProcess[]>();
  for (const process of trees) {
    treeByAgent.set(process.agent, [...(treeByAgent.get(process.agent) ?? []), process]);
  }
  return trees.map((process) => ({
    pid: process.pid,
    ppid: process.ppid,
    agent: process.agent,
    name: options.conversationNames?.get(process.pid) ?? describeProcess(process.command),
    command: displayCommand(process.command),
    fullCommand: fullDisplayCommand(process.command),
    ...(process.sessionId ? { sessionId: process.sessionId } : {}),
    cpuPercent: rounded(process.cpuPercent),
    elapsedSeconds: process.elapsedSeconds,
    rssMb: rounded(process.rssMb),
    depth: process.depth,
    flags: flagsFor(process, treeByAgent.get(process.agent) ?? []),
    ...(process.startedAt === undefined ? {} : { startedAt: process.startedAt }),
    ...(process.cwd ? { cwd: process.cwd } : {}),
    ...(process.state ? { state: process.state } : {}),
  }));
}

function displayCommand(command: string): string {
  const safe = displayPath(command, HOME_DIR);
  const parts = safe.trim().split(/\s+/u);
  const executableName = basename(parts.shift() ?? "process");
  const display = [isSimulationCommand(command) ? "node" : executableName, ...parts.slice(0, 3)].join(" ");
  return display.length <= 80 ? display : `${display.slice(0, 79)}…`;
}

// The full command with its options, home-anonymised the same way as the shortened `command`
// but never truncated: shown in the process row's "Details" disclosure (D4).
function fullDisplayCommand(command: string): string {
  const display = displayPath(command, HOME_DIR).trim();
  return display.length > PROCESS_FULL_COMMAND_MAX_LENGTH
    ? `${display.slice(0, PROCESS_FULL_COMMAND_MAX_LENGTH - 1)}…`
    : display;
}

export function processTreeForPid(processes: readonly PsProcess[], pid: number, omniPid: number): AgentProcess[] {
  const attributed = attributeProcesses(processes, omniPid);
  const selected = new Map(processes.map((process) => [process.pid, process]));
  const result: AgentProcess[] = [];
  const visit = (candidatePid: number): void => {
    const process = attributed.find((item) => item.pid === candidatePid);
    if (!process) return;
    result.push(process);
    for (const child of selected.values()) {
      if (child.ppid === candidatePid) visit(child.pid);
    }
  };
  visit(pid);
  return result;
}

export function rootProcessRecord(
  process: PsProcess,
  now = Date.now(),
): {
  pid: number;
  command: string;
  cwd?: string;
  startedAt: number;
} {
  return {
    pid: process.pid,
    command: process.command,
    ...(process.cwd ? { cwd: process.cwd } : {}),
    startedAt: process.startedAt ?? now - process.elapsedSeconds * 1_000,
  };
}
