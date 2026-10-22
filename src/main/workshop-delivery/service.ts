import type { AgentDriftResponse } from "../../shared/agents-ipc";
import type { WorkshopDeliveryStatus } from "../../shared/workshop-delivery-ipc";
import type { OperationStore } from "../operation-store";
import { readActiveWorkshop } from "../operations-paths";
import { readGitText } from "../git-read";
import { githubRepository } from "../../domain/storefront-origin";
import { readWorkshopSync } from "./sync";
import { readInstalledWorkshopPlugins } from "./installed-plugins";

export type WorkshopDeliveryOptions = Readonly<{
  userDataPath: string;
  home: string;
  operationStore: OperationStore;
  readDrift: () => Promise<AgentDriftResponse>;
}>;
export async function readWorkshopDelivery(options: WorkshopDeliveryOptions): Promise<WorkshopDeliveryStatus> {
  const diagnostics: string[] = [];
  let workshop: WorkshopDeliveryStatus["workshop"] = null;
  let plugins: WorkshopDeliveryStatus["plugins"] = { status: "ready", behind: 0, installations: [], diagnostics: [] };
  try {
    const active = await readActiveWorkshop(options.userDataPath);
    if (active) {
      const receipts = await options.operationStore.read();
      const confirmed =
        receipts.status === "ready"
          ? receipts.receipts.find(
              (receipt) => receipt.registered?.sourceId === active.id && receipt.workshopPush?.status === "pushed",
            )?.workshopPush
          : undefined;
      const sync = await readWorkshopSync(active.root, confirmed);
      const last =
        receipts.status === "ready"
          ? receipts.receipts.find(
              (receipt) =>
                receipt.workshopPush &&
                (receipt.registered?.sourceId === active.id || receipt.workshopPush.commit === sync.head),
            )
          : undefined;
      const failed =
        last?.workshopPush &&
        last.workshopPush.status !== "pushed" &&
        last.workshopPush.commit === sync.head &&
        sync.status !== "current";
      workshop = {
        sourceId: active.id,
        name: active.name,
        sync: failed
          ? {
              ...sync,
              status: "push-failed",
              diagnostic:
                last!.workshopPush!.diagnostic ??
                "The last workshop push was not confirmed. Retry after checking its upstream.",
            }
          : sync,
      };
      const remote = await readGitText(active.root, ["config", "--get", "remote.origin.url"]);
      plugins = await readInstalledWorkshopPlugins({
        home: options.home,
        workshop: active.root,
        repository: remote ? githubRepository(remote) : undefined,
        pushedCommit: sync.pushedCommit,
      });
      if (receipts.status !== "ready")
        diagnostics.push("Operation receipts could not be read. Push failure history is unavailable.");
    }
  } catch {
    diagnostics.push("Workshop delivery could not be read safely. Reopen its registered folder and check again.");
  }
  const projects: WorkshopDeliveryStatus["projects"] = [];
  try {
    const drift = await options.readDrift();
    const byProject = new Map<string, { projectId: string; conflicts: number; updates: number; unavailable: number }>();
    for (const binding of drift.bindings) {
      const entry = byProject.get(binding.projectId) ?? {
        projectId: binding.projectId,
        conflicts: 0,
        updates: 0,
        unavailable: 0,
      };
      if (binding.state === "conflict") entry.conflicts++;
      else if (binding.state === "update") entry.updates++;
      else if (binding.state === "unavailable") entry.unavailable++;
      byProject.set(entry.projectId, entry);
    }
    projects.push(...byProject.values());
  } catch {
    diagnostics.push("Project drift could not be read. Reopen the projects and check again.");
  }
  return { status: diagnostics.length ? "unavailable" : "ready", workshop, plugins, projects, diagnostics };
}
