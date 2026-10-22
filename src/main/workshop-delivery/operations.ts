import { runProviderCommand } from "./provider-cli";
import { randomUUID, createHash } from "node:crypto";
import type {
  ApplyOperationResponse,
  OperationPlan,
  OperationReceipt,
  PreviewMarketplaceResponse,
} from "../../shared/operations-ipc";
import { parseApplyOperationRequest } from "../../shared/operations-ipc";
import {
  workshopDeliveryRequestSchema,
  type WorkshopDeliveryRequest,
  type WorkshopDeliveryStatus,
  type PluginUpdateCommand,
  type PluginCommandResult,
} from "../../shared/workshop-delivery-ipc";
import { readActiveWorkshop } from "../operations-paths";
import type { OperationStore } from "../operation-store";
import { redactGitDiagnostic } from "../git-command";
import { pushWorkshop } from "./sync";
type Options = Readonly<{
  userDataPath: string;
  home: string;
  operationStore: OperationStore;
  read: () => Promise<WorkshopDeliveryStatus>;
  runCommand?: (command: PluginUpdateCommand) => Promise<void>;
}>;
type Stored = Readonly<{
  plan: OperationPlan;
  request: WorkshopDeliveryRequest;
  fingerprint: string;
  commands: readonly PluginUpdateCommand[];
  sync?: WorkshopDeliveryStatus["workshop"];
  targets: readonly string[];
}>;
function installationKey(plugin: WorkshopDeliveryStatus["plugins"]["installations"][number]): string {
  return JSON.stringify([plugin.harness, plugin.marketplace, plugin.name, plugin.scope, plugin.projectPath]);
}
function fingerprint(status: WorkshopDeliveryStatus): string {
  return createHash("sha256")
    .update(JSON.stringify([status.workshop, status.plugins]))
    .digest("hex");
}
export function createWorkshopDeliveryOperations(options: Options): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const plans = new Map<string, Stored>();
  let applying = false;
  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = workshopDeliveryRequestSchema.parse(raw),
      status = await options.read();
    const commands: PluginUpdateCommand[] = [];
    const targets: string[] = [];
    if (request.kind === "retry-workshop-push") {
      if (status.workshop?.sourceId !== request.sourceId)
        return {
          status: "blocked",
          reason: "workshop-changed",
          diagnostic: "The workshop changed. Refresh and preview Retry again.",
        };
      if (status.workshop.sync.behind || ["diverged", "no-upstream"].includes(status.workshop.sync.status))
        return {
          status: "blocked",
          reason: "workshop-upstream-blocked",
          diagnostic:
            status.workshop.sync.diagnostic ??
            "The workshop is behind or diverged. Reconcile Git manually; Omni never rewrites history.",
        };
    } else {
      const selected = status.plugins.installations.filter(
        (plugin) => plugin.harness === request.harness && plugin.state === "behind",
      );
      targets.push(...selected.map(installationKey));
      if (!selected.length)
        return {
          status: "blocked",
          reason: "plugins-current",
          diagnostic: "No confirmed outdated plugins are available for this agent. Check its installation records.",
        };
      if (selected.some((plugin) => !plugin.commands.length))
        return {
          status: "blocked",
          reason: "provider-update-unavailable",
          diagnostic:
            "An installation is managed or cannot be safely updated with the provider CLI. Inspect its delivery details.",
        };
      const seen = new Set<string>();
      for (const plugin of selected)
        for (const command of plugin.commands) {
          const key = JSON.stringify(command);
          if (!seen.has(key)) {
            seen.add(key);
            commands.push(command);
          }
        }
    }
    const hash = fingerprint(status);
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: request.kind,
      displayTarget: request.kind === "retry-workshop-push" ? status.workshop!.name : request.harness,
      actions: [],
      git: { mode: "disabled", warnings: [] },
      notes:
        request.kind === "retry-workshop-push"
          ? [
              "Push the workshop branch to its configured upstream, including older unpushed commits. History is never rewritten.",
            ]
          : [
              "Run only these provider CLI commands. Provider updates may require restarting the agent.",
              ...commands.map((command) => [command.executable, ...command.args].join(" ")),
            ],
      workshopDelivery: { fingerprint: hash, commands },
    };
    plans.set(plan.planId, { plan, request, fingerprint: hash, commands, sync: status.workshop, targets });
    return { status: "ready", plan };
  };
  const apply = async (raw: unknown): Promise<ApplyOperationResponse | undefined> => {
    const request = parseApplyOperationRequest(raw),
      stored = plans.get(request.planId);
    if (!stored) return undefined;
    if (applying) throw new Error("A workshop delivery operation is already running. Wait for its receipt and retry.");
    plans.delete(request.planId);
    applying = true;
    const results: PluginCommandResult[] = [];
    let diagnostic: string | undefined, workshopPush: OperationReceipt["workshopPush"];
    try {
      const current = await options.read();
      if (fingerprint(current) !== stored.fingerprint)
        throw new Error("Workshop delivery changed after preview. Preview the operation again.");
      if (stored.request.kind === "retry-workshop-push") {
        const workshop = await readActiveWorkshop(options.userDataPath);
        if (!workshop || workshop.id !== stored.request.sourceId)
          throw new Error("The workshop changed. Preview Retry again.");
        workshopPush = await pushWorkshop(workshop.root, stored.sync?.sync);
        if (workshopPush.status !== "pushed") diagnostic = workshopPush.diagnostic;
      } else {
        for (const command of stored.commands) {
          if (diagnostic) {
            results.push({ command, status: "skipped" });
            continue;
          }
          try {
            await (options.runCommand ?? ((command) => runProviderCommand(command, options.home)))(command);
            results.push({ command, status: "applied" });
          } catch (error) {
            diagnostic = redactGitDiagnostic(error);
            results.push({ command, status: "failed", diagnostic });
          }
        }
        if (!diagnostic) {
          const verified = await options.read(),
            harness = stored.request.harness;
          if (
            stored.targets.some(
              (target) =>
                !verified.plugins.installations.some(
                  (plugin) => installationKey(plugin) === target && plugin.state === "current",
                ),
            ) ||
            verified.plugins.installations.some((plugin) => plugin.harness === harness && plugin.state !== "current")
          )
            diagnostic =
              "Provider commands completed, but current installations could not be confirmed. Check delivery before retrying.";
        }
      }
    } catch (error) {
      diagnostic = redactGitDiagnostic(error);
    }
    try {
      const receipt: OperationReceipt = {
        operationId: randomUUID(),
        kind: stored.request.kind,
        status: diagnostic ? "failed" : "applied",
        appliedAt: new Date().toISOString(),
        displayTarget: stored.plan.displayTarget,
        actions: [],
        git: { mode: "disabled" },
        registered: stored.sync ? { sourceId: stored.sync.sourceId } : null,
        ...(workshopPush ? { workshopPush } : {}),
        ...(stored.request.kind === "update-workshop-plugins" ? { pluginUpdates: results } : {}),
        ...(diagnostic ? { diagnostic } : {}),
        ...(request.provenance ? { provenance: request.provenance } : {}),
      };
      const saved = await options.operationStore.append(receipt);
      if (saved.status !== "ready")
        throw new Error(
          "Workshop delivery receipt could not be saved. Inspect History and provider state before retrying.",
        );
      return { status: receipt.status, receipt };
    } finally {
      applying = false;
    }
  };
  return { preview, apply };
}
