import type { AgentStatus } from "../../shared/agents-ipc";
import type { TranslationFunction } from "../i18n";
import { harnessComplete } from "../agents/install-state";
import { agentRelativeTime } from "../review/agent-requests";
import { agentName } from "../agents/agent-utils";

export function agentRowState(
  agent: AgentStatus["harnesses"][number] | undefined,
  updating: boolean,
  version: string,
  t: TranslationFunction,
): Readonly<{ line: string; dot: "off" | "wait" | "ok" }> {
  if (!agent) return { line: t("agentsSetup.statusUnavailable"), dot: "off" };
  if (!agent.detected) return { line: t("agentSettings.notDetected"), dot: "off" };
  if (updating) return { line: t("agentSettings.updating"), dot: "wait" };
  const edited = agent.skills.filter((skill) => skill.state === "outdated");
  if (!agent.registered && edited.length)
    return {
      line:
        t("agentSettings.notConnected") +
        " · " +
        edited
          .map((skill) => t("agentSettings.retainedSkill", { skill: skill.name, agent: agentName(agent.harness) }))
          .join(" · "),
      dot: "wait",
    };
  const foreign = agent.skills.find((skill) => skill.state === "foreign");
  if (foreign) return { line: t("agentSettings.foreign", { skill: foreign.name }), dot: "wait" };
  if (!agent.registered) return { line: t("agentSettings.notConnected"), dot: "off" };
  if (!harnessComplete(agent)) return { line: t("agentSettings.incomplete"), dot: "wait" };
  return {
    line: t("agentSettings.connected", {
      version,
      session: agent.lastSeenAt
        ? t("agentSettings.lastSession", { time: agentRelativeTime(agent.lastSeenAt, t) })
        : t("agentSettings.waiting"),
    }),
    dot: agent.lastSeenAt ? "ok" : "wait",
  };
}
