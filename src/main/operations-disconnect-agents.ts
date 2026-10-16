import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseDisconnectAgentsRequest } from "../shared/agent-maintenance-ipc";
import type { OperationPlan, PreviewMarketplaceResponse, ApplyOperationResponse } from "../shared/operations-ipc";
import {
  agentHomeDir,
  guardScriptPath,
  harnessLabel,
  harnessPaths,
  inspectAgentHarnesses,
  mcpCliPath,
  type AgentHarnessOptions,
} from "./agent-harnesses";
import { createAgentFileOperations, type AgentFileAction } from "./agent-file-operation";
import { createOperationStore, type OperationStore } from "./operation-store";
import { readOptionalText } from "./fs-optional";
import { setClaudeMcpEntryRaw, setCodexSectionRaw } from "./mcp-entry";
import { guardEntryState, setGuardEntry } from "./hook-entry";
import { planAgentSkillRemovals } from "./agent-skill-removal";
import { hashContent } from "./marketplace-manifests";
import { unifiedDiff } from "./operations-register-mcp";

type Options = AgentHarnessOptions & Readonly<{ operationStore?: OperationStore; now?: () => number }>;
export function createDisconnectAgentsOperations(options: Options): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const homeDir = agentHomeDir(options);
  const operationStore =
    options.operationStore ?? createOperationStore(join(options.userDataPath, "omni/operations.json"));
  const files = createAgentFileOperations({ ...options, homeDir, operationStore });
  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parseDisconnectAgentsRequest(raw);
    const agent = (await inspectAgentHarnesses({ ...options, homeDir, harnesses: request.harnesses })).find(
      (agent) => agent.harness === request.harnesses[0],
    )!;
    const name = harnessLabel(agent.harness);
    if (!agent.registered)
      return { status: "blocked", reason: "agent-disconnected", diagnostic: `${name} is already disconnected.` };
    if (!agent.current)
      return {
        status: "blocked",
        reason: "agent-file-modified",
        diagnostic: `The Omni MCP entry in ${name} changed. Reinstall Omni before disconnecting.`,
      };
    const loaded = await operationStore.read();
    if (loaded.status !== "ready")
      return { status: "blocked", reason: "operations-unavailable", diagnostic: loaded.diagnostic };
    let actions: AgentFileAction[];
    try {
      actions = [...(await planAgentSkillRemovals(agent, loaded.receipts, homeDir))];
    } catch (error: unknown) {
      return {
        status: "blocked",
        reason: "agent-file-modified",
        diagnostic:
          error instanceof Error
            ? error.message
            : "The agent files could not be removed safely. Inspect them, then retry from Settings.",
      };
    }
    const paths = harnessPaths(agent.harness);
    const before = await readOptionalText(join(homeDir, paths.settings));
    const after =
      agent.harness === "claude-code" ? setClaudeMcpEntryRaw(before, undefined) : setCodexSectionRaw(before, undefined);
    if (before !== undefined && after !== undefined && before !== after)
      actions.push(manifestAction(homeDir, paths.settings, before, after));
    const guardBefore = await readOptionalText(join(homeDir, paths.guardSettings));
    const guard = guardEntryState(guardBefore, agent.harness, guardScriptPath(options));
    if (guard.registered && !guard.current)
      return {
        status: "blocked",
        reason: "agent-file-modified",
        diagnostic: `The Omni guard hook in ${name} changed. Reinstall Omni before disconnecting.`,
      };
    const guardAfter = setGuardEntry(guardBefore, undefined);
    if (guardBefore !== undefined && guardAfter !== undefined && guardBefore !== guardAfter)
      actions.push(manifestAction(homeDir, paths.guardSettings, guardBefore, guardAfter));
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "disconnect-agents",
      displayTarget: name,
      actions: actions.map(({ absolutePath: _path, content: _content, beforeContent: _before, ...action }) => action),
      git: { mode: "not-a-repository", warnings: [] },
    };
    files.remember(plan, actions, mcpCliPath(options), {
      harness: agent.harness,
      agentSetup: { action: "disconnect", harnesses: request.harnesses },
    });
    return { status: "ready", plan };
  };
  return { preview, apply: files.apply };
}
function manifestAction(homeDir: string, relativePath: string, before: string, content: string): AgentFileAction {
  return {
    kind: "write-file",
    relativePath,
    manifest: true,
    absolutePath: join(homeDir, relativePath),
    content,
    beforeContent: before,
    beforeHash: hashContent(before),
    byteLength: Buffer.byteLength(content),
    diff: unifiedDiff(before, content, relativePath),
  };
}
