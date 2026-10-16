import type { AgentHarnessInspection } from "./agent-harnesses";
import { harnessLabel, harnessPaths } from "./agent-harnesses";
import type { OperationReceipt } from "../shared/operations-ipc";
import { hashContent } from "./marketplace-manifests";

/** An unattended update may replace the last installed bytes, never an owner's later edits. */
export function agentUpdateConflict(
  agent: AgentHarnessInspection,
  receipts: readonly OperationReceipt[],
): string | undefined {
  for (const skill of agent.skillDetails) {
    if (skill.state !== "outdated") continue;
    for (const [path, content] of skill.contents) {
      const relativePath = `${harnessPaths(agent.harness).skills}/${skill.name}/${path}`;
      const installed = receipts.find(
        (receipt) =>
          receipt.kind === "install-agents" &&
          receipt.status === "applied" &&
          !receipt.restored &&
          receipt.files?.some((file) => file.relativePath === relativePath),
      );
      const file = installed?.files?.find((file) => file.relativePath === relativePath);
      if (!file || file.contentHash !== hashContent(content))
        return `The Omni skill ${skill.name} in ${harnessLabel(agent.harness)} has local edits. Keep them, then reinstall Omni from Settings.`;
    }
  }
  return undefined;
}
