import type { AgentHarness, AgentStatus } from "../../shared/agents-ipc";
import type { OperationReceipt } from "../../shared/operations-ipc";
import { tCount, type AppLanguage, type TranslationFunction, type TranslationKey } from "../i18n";
import { harnessComplete, type AgentHarnessStatus } from "./install-state";

export const AGENT_HARNESSES: readonly AgentHarness[] = ["claude-code", "codex"];
export type { AgentHarnessStatus };
const isAgentComplete = harnessComplete;

export function agentName(harness: AgentHarness): string {
  return harness === "claude-code" ? "Claude Code" : "Codex";
}

function harnessRoot(harness: AgentHarness): string {
  return harness === "claude-code" ? "~/.claude" : "~/.codex";
}

export function statusForHarness(status: AgentStatus | null, harness: AgentHarness): AgentHarnessStatus | undefined {
  return status?.harnesses.find((item) => item.harness === harness);
}

function relativeTimeCopy(timestamp: string, t: TranslationFunction): string {
  const value = relativeTime(timestamp);
  return t(`agentsSetup.relative.${value.unit}` as TranslationKey, { count: value.amount });
}

export function harnessSummary(
  observed: AgentHarnessStatus | undefined,
  t: TranslationFunction,
  language: AppLanguage,
): string {
  if (!observed) return t("agentsSetup.loadingItem");
  if (!observed.detected) return t("agentsSetup.notFound", { path: harnessRoot(observed.harness) });
  const nothingInstalled = !observed.registered && observed.skills.every((skill) => skill.state === "missing");
  const toolServerKey = observed.registered
    ? observed.current
      ? "agentsSetup.toolServer.installed"
      : "agentsSetup.toolServer.update"
    : "agentsSetup.toolServer.add";
  const parts = [...(nothingInstalled ? [t("agentsSetup.nothingInstalled")] : []), t(toolServerKey)];
  const skillCounts = [
    ["installed", observed.skills.filter((skill) => skill.state === "installed").length],
    ["add", observed.skills.filter((skill) => skill.state === "missing").length],
    ["update", observed.skills.filter((skill) => skill.state === "outdated").length],
  ] as const;
  for (const [kind, count] of [skillCounts[1], skillCounts[2], skillCounts[0]]) {
    if (count > 0) parts.push(tCount(`agentsSetup.skills.${kind}`, count, {}, language));
  }
  for (const skill of observed.skills.filter((candidate) => candidate.state === "foreign"))
    parts.push(t("agentsSetup.foreignSkill", { name: skill.name }));
  if (isAgentComplete(observed))
    parts.push(
      observed.lastSeenAt
        ? t("agentsSetup.calledOmni", { time: relativeTimeCopy(observed.lastSeenAt, t) })
        : t("agentsSetup.neverCalled"),
    );
  return parts.join(" · ");
}

export function receiptHarnessNames(receipt: OperationReceipt, language: "en" | "fr"): string {
  const harnesses =
    receipt.agentSetup?.harnesses ??
    (receipt.harness
      ? [receipt.harness]
      : receipt.harnessSetting
        ? [receipt.harnessSetting.harness]
        : AGENT_HARNESSES.filter(
            (harness) =>
              receipt.actions.some((action) =>
                action.relativePath.includes(harness === "claude-code" ? ".claude" : ".codex"),
              ) || receipt.displayTarget.includes(harness === "claude-code" ? "~/.claude" : "~/.codex"),
          ));
  return new Intl.ListFormat(language, { type: "conjunction" }).format(harnesses.map(agentName));
}

export function latestInstallAgentsReceiptId(
  receipts: readonly OperationReceipt[],
  target: OperationReceipt,
): string | undefined {
  const agents = target.agentSetup?.harnesses;

  return receipts
    .filter(
      (receipt) =>
        (receipt.kind === "install-agents" || receipt.kind === "disconnect-agents") &&
        receipt.status === "applied" &&
        !receipt.restored &&
        (!agents ||
          agents.some(
            (agent) =>
              receipt.agentSetup?.harnesses.includes(agent) ??
              receipt.actions.some((action) =>
                action.relativePath.startsWith(agent === "claude-code" ? ".claude" : ".codex"),
              ),
          )),
    )
    .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))[0]?.operationId;
}

function relativeTime(timestamp: string, now = Date.now()): { amount: number; unit: "second" | "minute" | "hour" } {
  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return { amount: seconds, unit: "second" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { amount: minutes, unit: "minute" };
  return { amount: Math.floor(minutes / 60), unit: "hour" };
}
