// Process-action and on-demand read parsers split out of `activity-ipc-parsers.ts` to keep
// that file under the project's line-count target: preview/plan parsing for `stop-process`,
// `signal-process`, `renice-process` and `remove-worktree` (D5 — kill/pause/resume/renice reuse
// `previewProcess`'s eligibility, just with a different plan kind), plus the two Activity
// iteration 3 reads that are never part of the snapshot itself — listening ports and the
// open-terminal path check (D2/D4/D5).
import {
  assertKeys,
  numberValue,
  opaque,
  record,
  relativeDisplay,
  text,
  workingDirectory,
} from "./activity-ipc-parsers";
import type {
  ActivityOpenTerminalRequest,
  ActivityOpenTerminalResponse,
  ActivityPlan,
  ActivityPortsRequest,
  ActivityPortsResponse,
  ActivityPreviewRequest,
} from "./activity-ipc";

function parseProcessActions(
  value: unknown,
): readonly Readonly<{ pid: number; command: string; cpuPercent: number }>[] {
  if (!Array.isArray(value)) throw new Error("Activity actions must be an array.");
  return value.map((entry) => {
    const action = record(entry, "Process action");
    assertKeys(action, ["pid", "command", "cpuPercent"], "Process action");
    return {
      pid: numberValue(action.pid, "Process pid", true),
      command: text(action.command, "Process command"),
      cpuPercent: numberValue(action.cpuPercent, "Process CPU"),
    };
  });
}

export function parsePlan(value: unknown): ActivityPlan {
  const item = record(value, "Activity plan");
  if (item.kind === "signal-process") {
    assertKeys(item, ["planId", "kind", "displayTarget", "action", "actions"], "Activity plan");
    if (!["kill", "pause", "resume"].includes(item.action as string)) throw new Error("Signal action is invalid.");
    return {
      planId: opaque(item.planId, "Activity plan id"),
      kind: item.kind,
      displayTarget: text(item.displayTarget, "Activity target"),
      action: item.action as "kill" | "pause" | "resume",
      actions: parseProcessActions(item.actions),
    };
  }
  if (item.kind === "renice-process") {
    assertKeys(item, ["planId", "kind", "displayTarget", "nice", "actions"], "Activity plan");
    if (item.nice !== 10 && item.nice !== 0) throw new Error("Renice value is invalid.");
    return {
      planId: opaque(item.planId, "Activity plan id"),
      kind: item.kind,
      displayTarget: text(item.displayTarget, "Activity target"),
      nice: item.nice,
      actions: parseProcessActions(item.actions),
    };
  }
  assertKeys(item, ["planId", "kind", "displayTarget", "actions"], "Activity plan");
  const planId = opaque(item.planId, "Activity plan id");
  const displayTarget = text(item.displayTarget, "Activity target");
  if (!Array.isArray(item.actions)) {
    throw new Error("Activity actions must be an array.");
  }
  if (item.kind === "stop-process") {
    return { planId, kind: item.kind, displayTarget, actions: parseProcessActions(item.actions) };
  }
  if (item.kind === "remove-worktree") {
    return {
      planId,
      kind: item.kind,
      displayTarget,
      actions: item.actions.map((value) => {
        const action = record(value, "Worktree action");
        assertKeys(action, ["projectId", "worktreeId", "kind"], "Worktree action");
        if (action.kind !== "git-worktree" && action.kind !== "folder") {
          throw new Error("Worktree action kind is invalid.");
        }
        return {
          projectId: opaque(action.projectId, "Worktree project id"),
          worktreeId: relativeDisplay(action.worktreeId, "Worktree id"),
          kind: action.kind,
        };
      }),
    };
  }
  throw new Error("Activity plan kind is invalid.");
}

export function parseActivityPreviewRequest(value: unknown): ActivityPreviewRequest {
  const item = record(value, "Activity preview request");
  if (item.kind === "stop-process") {
    assertKeys(item, ["kind", "pid"], "Activity preview request");
    return { kind: item.kind, pid: numberValue(item.pid, "Process pid", true) };
  }
  if (item.kind === "signal-process") {
    assertKeys(item, ["kind", "pid", "action"], "Activity preview request");
    if (!["kill", "pause", "resume"].includes(item.action as string)) throw new Error("Signal action is invalid.");
    return {
      kind: item.kind,
      pid: numberValue(item.pid, "Process pid", true),
      action: item.action as "kill" | "pause" | "resume",
    };
  }
  if (item.kind === "renice-process") {
    assertKeys(item, ["kind", "pid", "nice"], "Activity preview request");
    if (item.nice !== 10 && item.nice !== 0) throw new Error("Renice value is invalid.");
    return { kind: item.kind, pid: numberValue(item.pid, "Process pid", true), nice: item.nice };
  }
  if (item.kind === "remove-worktree") {
    assertKeys(item, ["kind", "projectId", "worktreeId"], "Activity preview request");
    return {
      kind: item.kind,
      projectId: opaque(item.projectId, "Worktree project id"),
      worktreeId: relativeDisplay(item.worktreeId, "Worktree id"),
    };
  }
  throw new Error("Activity preview kind is invalid.");
}

const MAX_PORT_PIDS = 32;

export function parseActivityPortsRequest(value: unknown): ActivityPortsRequest {
  const item = record(value, "Activity ports request");
  assertKeys(item, ["pids"], "Activity ports request");
  if (
    !Array.isArray(item.pids) ||
    item.pids.length === 0 ||
    item.pids.length > MAX_PORT_PIDS ||
    item.pids.some((pid) => !Number.isSafeInteger(pid) || pid < 0)
  ) {
    throw new Error("Activity ports pids are invalid.");
  }
  return { pids: item.pids as number[] };
}

export function parseActivityPortsResponse(value: unknown): ActivityPortsResponse {
  const item = record(value, "Activity ports response");
  assertKeys(item, ["ports"], "Activity ports response");
  if (!Array.isArray(item.ports)) throw new Error("Activity ports are invalid.");
  return {
    ports: item.ports.map((entry) => {
      const port = record(entry, "Activity port");
      assertKeys(port, ["pid", "port"], "Activity port");
      return { pid: numberValue(port.pid, "Port pid", true), port: numberValue(port.port, "Port number", true) };
    }),
  };
}

export function parseActivityOpenTerminalRequest(value: unknown): ActivityOpenTerminalRequest {
  const item = record(value, "Activity open terminal request");
  assertKeys(item, ["cwd"], "Activity open terminal request");
  return { cwd: workingDirectory(item.cwd, "Terminal working directory") };
}

export function parseActivityOpenTerminalResponse(value: unknown): ActivityOpenTerminalResponse {
  const item = record(value, "Activity open terminal response");
  if (item.status === "blocked") {
    assertKeys(item, ["status", "diagnostic"], "Activity open terminal response");
    return { status: "blocked", diagnostic: text(item.diagnostic, "Activity diagnostic") };
  }
  assertKeys(item, ["status"], "Activity open terminal response");
  if (item.status !== "opened") throw new Error("Activity open terminal status is invalid.");
  return { status: "opened" };
}
