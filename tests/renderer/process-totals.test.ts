import { describe, expect, it } from "vitest";

import { subtreeTotals, subtreeTotalsByRoot } from "../../src/renderer/activity/process-totals";
import type { AgentProcess } from "../../src/shared/activity-ipc";

function process(overrides: Partial<AgentProcess> & Pick<AgentProcess, "pid" | "ppid">): AgentProcess {
  return {
    agent: "codex",
    name: "process",
    command: "process",
    cpuPercent: 0,
    elapsedSeconds: 0,
    rssMb: 0,
    depth: 0,
    flags: [],
    ...overrides,
  };
}

// Three levels, parent's own values deliberately smaller than one child's (D3's proof case: the
// owner saw a stale order because a naive "sort by own value" put a light root above a heavy
// leaf). The subtree total must still add the parent's own light values to every descendant's.
const THREE_LEVELS: readonly AgentProcess[] = [
  process({ pid: 1, ppid: 0, depth: 0, cpuPercent: 1, rssMb: 100 }),
  process({ pid: 2, ppid: 1, depth: 1, cpuPercent: 2, rssMb: 50 }),
  process({ pid: 3, ppid: 2, depth: 2, cpuPercent: 20, rssMb: 300 }),
];

describe("subtreeTotals", () => {
  it("sums own values across every descendant, even when the root's own value is the smallest in the tree", () => {
    expect(subtreeTotals(THREE_LEVELS, 1)).toEqual({ cpuPercent: 23, rssMb: 450 });
    expect(subtreeTotals(THREE_LEVELS, 2)).toEqual({ cpuPercent: 22, rssMb: 350 });
    expect(subtreeTotals(THREE_LEVELS, 3)).toEqual({ cpuPercent: 20, rssMb: 300 });
  });

  it("returns zero for a pid that resolves to nothing in the given process list", () => {
    expect(subtreeTotals(THREE_LEVELS, 999)).toEqual({ cpuPercent: 0, rssMb: 0 });
  });

  it("does not loop forever on a cyclic parent chain", () => {
    const cyclic: readonly AgentProcess[] = [
      process({ pid: 10, ppid: 11, depth: 0, cpuPercent: 1, rssMb: 1 }),
      process({ pid: 11, ppid: 10, depth: 0, cpuPercent: 1, rssMb: 1 }),
    ];
    expect(subtreeTotals(cyclic, 10)).toEqual({ cpuPercent: 2, rssMb: 2 });
  });
});

describe("subtreeTotalsByRoot", () => {
  it("maps every depth-0 process to its own subtree total", () => {
    const withSecondRoot: readonly AgentProcess[] = [
      ...THREE_LEVELS,
      process({ pid: 4, ppid: 0, depth: 0, cpuPercent: 5, rssMb: 7 }),
    ];
    const byRoot = subtreeTotalsByRoot(withSecondRoot);
    expect(byRoot.get(1)).toEqual({ cpuPercent: 23, rssMb: 450 });
    expect(byRoot.get(4)).toEqual({ cpuPercent: 5, rssMb: 7 });
    expect(byRoot.has(2)).toBe(false);
  });
});
