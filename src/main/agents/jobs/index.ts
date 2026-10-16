import { composeJob } from "./compose";

export const AGENT_JOBS = { compose: composeJob } as const;
export type AgentJobId = keyof typeof AGENT_JOBS;

export function getAgentJob(id: AgentJobId) {
  return AGENT_JOBS[id];
}
