import type { AgentHarness, AgentStatus } from "../../shared/agents-ipc";
import type { useI18n } from "../i18n";

export type AgentHarnessStatus = AgentStatus["harnesses"][number];

/** Which of the three installed parts still differ from the bundle, per harness (item 9): the
 * "need rule" exposes this so Home can name exactly what changes instead of always saying
 * "skills outdated". */
export type HarnessNeedParts = Readonly<{ mcp: boolean; skills: boolean; guard: boolean }>;

/**
 * One rule for "what does Omni need to do for the agents" — Home's next action and the setup
 * page's head both read it, so the copy never says "Install" to a user who already installed
 * (flow audit F1/F5). Per detected harness: `install` while it has no Omni entry yet, `update`
 * once it is registered but its entry, skills, or guard lag behind the bundle. `parts` carries
 * the per-harness breakdown for every harness in `install` or `update`, in that order.
 */
export type AgentsInstallNeed = Readonly<{
  install: readonly AgentHarness[];
  update: readonly AgentHarness[];
  detected: readonly AgentHarness[];
  parts: readonly (Readonly<{ harness: AgentHarness }> & HarnessNeedParts)[];
}>;

/**
 * The one completeness rule (item 7): a harness is fully installed only when its MCP entry is
 * registered and current, every bundle skill is installed, and Omni's guard hook is present and
 * current. `agent-utils.ts` imports this instead of keeping its own copy.
 */
export function harnessComplete(observed: AgentHarnessStatus | undefined): boolean {
  return Boolean(
    observed?.registered &&
    observed.current &&
    observed.guard &&
    observed.skills.every((skill) => skill.state === "installed"),
  );
}

function harnessNeedParts(observed: AgentHarnessStatus): HarnessNeedParts {
  return {
    mcp: !observed.registered || !observed.current,
    skills: observed.skills.some((skill) => skill.state !== "installed"),
    guard: !observed.guard,
  };
}

export function agentsInstallNeed(harnesses: AgentStatus["harnesses"] | undefined): AgentsInstallNeed {
  const detected = (harnesses ?? []).filter((harness) => harness.detected);
  const install = detected.filter((harness) => !harness.registered);
  const update = detected.filter((harness) => harness.registered && !harnessComplete(harness));
  return {
    detected: detected.map((harness) => harness.harness),
    install: install.map((harness) => harness.harness),
    update: update.map((harness) => harness.harness),
    parts: [...install, ...update].map((harness) => ({ harness: harness.harness, ...harnessNeedParts(harness) })),
  };
}

export function agentsNeedKind(need: AgentsInstallNeed): "none" | "install" | "update" {
  if (need.install.length) return "install";
  if (need.update.length) return "update";
  return "none";
}

function harnessNames(harnesses: readonly AgentHarness[], t: ReturnType<typeof useI18n>["t"]): string {
  return harnesses.map((harness) => t(harness === "claude-code" ? "agents.claudeCode" : "agents.codex")).join(", ");
}

/**
 * "Install Omni for your agents" when every detected harness needs installing; "Install Omni
 * for Codex" when only some do; "Update Omni for Claude Code" when the rest is current; both
 * clauses when the machine mixes the two (the owner's: Claude Code outdated, Codex absent).
 */
export function agentsNeedTitle(need: AgentsInstallNeed, t: ReturnType<typeof useI18n>["t"]): string {
  const everyDetected = need.install.length === need.detected.length;
  if (need.install.length && need.update.length)
    return t("agents.need.installAndUpdate", {
      install: harnessNames(need.install, t),
      update: harnessNames(need.update, t),
    });
  if (need.install.length)
    return everyDetected
      ? t("agents.need.installAll")
      : t("agents.need.installSome", { harnesses: harnessNames(need.install, t) });
  if (need.update.length)
    return need.update.length === need.detected.length
      ? t("agents.need.updateAll")
      : t("agents.need.updateSome", { harnesses: harnessNames(need.update, t) });
  return t("agents.need.installAll");
}

function joinTranslated(items: readonly string[], and: string): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]}${and}${items[1]}`;
  return `${items.slice(0, -1).join(", ")}${and}${items.at(-1)}`;
}

/**
 * Names what Home's next-action card will actually change across every harness that still
 * needs work — the tool server, the skills, Omni's guard hook, or some combination — instead of
 * the old fixed "skills outdated" sentence, which was wrong whenever only the tool server path
 * or only the guard needed touching (baseline ledger R3).
 */
export function agentsNeedDescription(need: AgentsInstallNeed, t: ReturnType<typeof useI18n>["t"]): string {
  const items = [
    ...(need.parts.some((part) => part.mcp) ? [t("agentsSetup.need.partMcp")] : []),
    ...(need.parts.some((part) => part.skills) ? [t("agentsSetup.need.partSkills")] : []),
    ...(need.parts.some((part) => part.guard) ? [t("agentsSetup.need.partGuard")] : []),
  ];
  if (items.length === 0) return t("agentsSetup.need.descriptionFallback");
  return t("agentsSetup.need.description", { items: joinTranslated(items, t("agentsSetup.need.and")) });
}
