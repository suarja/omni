import type { RegistryView } from "../../../domain/project-source-registry";
import { activeWorkshop } from "../../../domain/source-roles";
import type { AgentStatus } from "../../../shared/agents-ipc";

export type WorkspaceSetupStep = "marketplace" | "project" | "agents";
export const WORKSPACE_SETUP_STEPS: readonly WorkspaceSetupStep[] = ["marketplace", "project", "agents"];
export type WorkspaceSetupProgress = Readonly<{
  done: Readonly<Record<WorkspaceSetupStep, boolean>>;
  count: number;
  current?: WorkspaceSetupStep;
  detected: AgentStatus["harnesses"];
  connected: AgentStatus["harnesses"];
}>;

export function deriveWorkspaceSetupProgress(
  registry: RegistryView,
  status: AgentStatus | null,
): WorkspaceSetupProgress {
  const connected = status?.harnesses.filter((agent) => agent.registered) ?? [];
  const done = {
    marketplace: Boolean(activeWorkshop(registry)),
    project: registry.projects.some((project) => !project.archivedAt),
    agents: connected.length > 0,
  };
  return {
    done,
    count: WORKSPACE_SETUP_STEPS.filter((step) => done[step]).length,
    current: WORKSPACE_SETUP_STEPS.find((step) => !done[step]),
    detected: status?.harnesses.filter((agent) => agent.detected) ?? [],
    connected,
  };
}
