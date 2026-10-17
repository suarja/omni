import type { DesktopApi } from "../../../shared/ipc";
import type { AgentStatus } from "../../../shared/agents-ipc";

export type WorkspaceMapApi = Partial<
  Pick<DesktopApi, "getSettings" | "setSettings" | "getAgentStatus" | "onReviewChanged">
>;
type WorkspaceMapReads = {
  hidden?: boolean;
  status?: AgentStatus | null;
  preferences?: Promise<boolean>;
  agents?: Promise<AgentStatus | null>;
};
const observations = new WeakMap<WorkspaceMapApi, WorkspaceMapReads>();

/** Retain received observations across canvas routes, without storing completion flags. */
export function workspaceMapReads(api: WorkspaceMapApi): WorkspaceMapReads {
  let reads = observations.get(api);
  if (!reads) {
    reads = {};
    observations.set(api, reads);
  }
  return reads;
}

export function readWorkspaceMapPreferences(api: WorkspaceMapApi): Promise<boolean> {
  const reads = workspaceMapReads(api);
  reads.preferences ??= Promise.resolve()
    .then(() => api.getSettings?.())
    .then((settings) => {
      reads.hidden = settings?.workspaceSetupHidden ?? false;
      return reads.hidden;
    })
    .catch((error: unknown) => {
      reads.preferences = undefined;
      throw error;
    });
  return reads.preferences;
}

export function readWorkspaceMapAgents(api: WorkspaceMapApi): Promise<AgentStatus | null> {
  const reads = workspaceMapReads(api);
  reads.agents ??= Promise.resolve()
    .then(() => api.getAgentStatus?.())
    .then((status) => {
      reads.status = status ?? null;
      return reads.status;
    })
    .catch((error: unknown) => {
      reads.agents = undefined;
      throw error;
    });
  return reads.agents;
}

export function refreshWorkspaceMapAgents(api: WorkspaceMapApi): void {
  const reads = workspaceMapReads(api);
  reads.agents = undefined;
}

export function retainWorkspaceSetupPreference(api: WorkspaceMapApi, hidden: boolean): void {
  const reads = workspaceMapReads(api);
  reads.hidden = hidden;
  reads.preferences = Promise.resolve(hidden);
}
