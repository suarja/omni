import type { Observation, RegistryEntryView } from "../../domain/project-source-registry";
import type { AgentFindSkillResponse } from "../../shared/agents-ipc";
import type { RegistryIpcServices } from "../registry-ipc";

export async function readRegisteredRoots(
  registry: RegistryIpcServices,
  entries: readonly RegistryEntryView[],
): Promise<
  Readonly<{
    observations: readonly Readonly<{ entry: RegistryEntryView; observation: Observation }>[];
    unreadRoots: AgentFindSkillResponse["unreadRoots"];
  }>
> {
  const observations: { entry: RegistryEntryView; observation: Observation }[] = [];
  const unreadRoots: Array<AgentFindSkillResponse["unreadRoots"][number]> = [];
  for (const entry of entries) {
    if (entry.archivedAt !== undefined || entry.availability !== "available") {
      unreadRoots.push({
        root: entry.ref,
        name: entry.displayName,
        reason: entry.archivedAt ? "archived" : entry.availability,
      });
      continue;
    }
    try {
      const result = await registry.observeRegisteredEntry(entry.ref);
      if (result.status === "observed") observations.push({ entry, observation: result.observation });
      else unreadRoots.push({ root: entry.ref, name: entry.displayName, reason: result.status });
    } catch {
      unreadRoots.push({
        root: entry.ref,
        name: entry.displayName,
        reason: "Root observation failed; reopen the registered root.",
      });
    }
  }
  return { observations, unreadRoots };
}
