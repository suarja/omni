import { activityHarnessAdapters } from "../adapters/activity";
import type { AgentClient } from "./agent-gateway/server";
import type { Platform, RawProcess } from "./platform/platform";

export type AgentClientIdentityOptions = Readonly<{
  platform: Platform;
  omniPid: number;
}>;

function findVerifiedChain(
  processes: readonly RawProcess[],
  requestedPid: number,
  omniPid: number,
  isAlive: (pid: number) => boolean,
): { rootPid: number; harness: "claude-code" | "codex" } | undefined {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const seen = new Set<number>();
  let pid = requestedPid;
  for (let depth = 0; depth < 64; depth += 1) {
    if (pid === omniPid || seen.has(pid) || !isAlive(pid)) return undefined;
    seen.add(pid);
    const process = byPid.get(pid);
    if (!process) return undefined;
    const adapter = activityHarnessAdapters.find((candidate) => candidate.isRoot(process.command));
    if (adapter) {
      if (adapter.harness !== "claude-code" && adapter.harness !== "codex") return undefined;
      return { rootPid: pid, harness: adapter.harness };
    }
    pid = process.ppid;
  }
  return undefined;
}

export function createAgentClientIdentityResolver(
  options: AgentClientIdentityOptions,
): (client: AgentClient) => Promise<Partial<AgentClient>> {
  let processList: Promise<readonly RawProcess[]> | undefined;
  const readProcesses = (): Promise<readonly RawProcess[]> => {
    if (processList) return processList;
    const current = options.platform.processes.list();
    processList = current;
    void current
      .finally(() => {
        if (processList === current) processList = undefined;
      })
      .catch(() => undefined);
    return current;
  };

  const inFlightByPid = new Map<number, Promise<Partial<AgentClient>>>();
  const identifyPid = async (pid: number): Promise<Partial<AgentClient>> => {
    const processes = await readProcesses();
    const verified = findVerifiedChain(processes, pid, options.omniPid, (candidate) =>
      options.platform.processes.isAlive(candidate),
    );
    if (!verified) return {};
    const cwdPids = [...new Set([pid, verified.rootPid])];
    const directories = await options.platform.processes.workingDirectories(cwdPids);
    const cwd = cwdPids.map((cwdPid) => directories.get(cwdPid)).find((value) => value?.startsWith("/"));
    return { harness: verified.harness, ...(cwd ? { cwd } : {}) };
  };

  return (client) => {
    const pid = client.pid;
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve({});
    const existing = inFlightByPid.get(pid);
    if (existing) return existing;
    const current = identifyPid(pid);
    inFlightByPid.set(pid, current);
    void current
      .finally(() => {
        if (inFlightByPid.get(pid) === current) inFlightByPid.delete(pid);
      })
      .catch(() => undefined);
    return current;
  };
}
