// D3 (Activity iteration 3): subtree CPU/memory totals, computed once here and reused by both
// the process tree (root row: own + subtree) and the agents list (side value: subtree only) so
// the two never disagree. Pure and cheap enough to recompute on every snapshot — callers memoise
// on the snapshot object itself (`useMemo(() => …, [snapshot])`), which is what keeps the order
// from ever going stale after a poll.
import type { AgentProcess } from "../../shared/activity-ipc";

export type ProcessTotals = Readonly<{ cpuPercent: number; rssMb: number }>;

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

// The full subtree rooted at `rootPid` (the root itself included), guarded against a cyclic
// parent chain the way the renderer's own tree builders already are.
export function subtreeTotals(processes: readonly AgentProcess[], rootPid: number): ProcessTotals {
  const byParent = new Map<number, AgentProcess[]>();
  for (const process of processes) {
    byParent.set(process.ppid, [...(byParent.get(process.ppid) ?? []), process]);
  }
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  let cpuPercent = 0;
  let rssMb = 0;
  const visit = (pid: number, seen: Set<number>): void => {
    if (seen.has(pid)) return;
    const process = byPid.get(pid);
    if (!process) return;
    const nextSeen = new Set(seen).add(pid);
    cpuPercent += process.cpuPercent;
    rssMb += process.rssMb;
    for (const child of byParent.get(pid) ?? []) visit(child.pid, nextSeen);
  };
  visit(rootPid, new Set());
  return { cpuPercent: rounded(cpuPercent), rssMb: rounded(rssMb) };
}

// Every depth-0 process in `processes`, mapped to its own subtree totals — the shape the agents
// list needs (one lookup per row) without recomputing the whole tree per row.
export function subtreeTotalsByRoot(processes: readonly AgentProcess[]): ReadonlyMap<number, ProcessTotals> {
  const roots = processes.filter((process) => process.depth === 0);
  return new Map(roots.map((root) => [root.pid, subtreeTotals(processes, root.pid)]));
}
