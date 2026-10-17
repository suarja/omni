import type { AgentRequest, ApprovalReason } from "../../shared/agents-ipc";
import type { AgentRequestsStore } from "./requests-store";
import { describeApprovalReason } from "../../shared/approval-reason-text";

type RequestNotification = Readonly<{
  on(event: "click", listener: () => void): unknown;
  show(): void;
  close(): void;
}>;
type AttentionOptions = Readonly<{
  requests: AgentRequestsStore;
  app: { setBadgeCount(count: number): unknown };
  createNotification: (options: { title: string; body: string }) => RequestNotification;
  isFocused: () => boolean;
  openRequest: (requestId: string) => void;
}>;

function reasonText(reason: ApprovalReason | undefined): string {
  return reason ? describeApprovalReason(reason) : "Review the requested change";
}

function actionText(request: AgentRequest): string {
  const input = request.request;
  switch (input.kind) {
    case "link-storefront":
      return `Link storefront ${request.plan.kind === "assign" ? input.path : request.plan.displayTarget}`;
    case "register-project":
      return `Register project ${request.plan.kind === "assign" ? input.path : request.plan.displayTarget}`;
    case "install-external-skill":
      return `Install external skill ${input.skillName}`;
    case "publish-plugin":
      return `Publish plugin ${input.pluginId}`;
    case "make-compatible":
      return `Make ${input.packageId ?? (request.plan.kind === "assign" ? input.sourceId : request.plan.displayTarget)} compatible with ${input.harness === "codex" ? "Codex" : "Claude Code"}`;
    case "write-skill":
      return `Write skill ${input.folderName}`;
    case "assign":
      return `Assign ${input.artifactPath ?? input.packageId}`;
    case "import-artifact":
      return `Capture ${input.relativePath}`;
    case "remove-skill":
      return "Review removal";
    case "restore-skill":
      return "Review restore";
    case "update-and-maintain":
      return `Update and maintain ${input.request.folderName}`;
    case "maintain-current":
      return `Maintain ${input.source.artifactPath}`;
  }
}

/** Startup restores counts only. Each new durable pending request can notify once per process. */
export async function watchAgentRequestAttention(options: AttentionOptions): Promise<() => void> {
  const seen = new Set<string>();
  const notifications = new Map<string, RequestNotification>();
  const update = (requests: readonly AgentRequest[], announce: boolean): void => {
    const pending = requests.filter((request) => request.approval === "omni" && request.status === "pending");
    options.app.setBadgeCount(pending.length);
    const pendingIds = new Set(pending.map((request) => request.requestId));
    for (const [id, notification] of notifications) {
      if (pendingIds.has(id)) continue;
      notification.close();
      notifications.delete(id);
    }
    for (const request of pending) {
      if (seen.has(request.requestId)) continue;
      seen.add(request.requestId);
      if (!announce || options.isFocused()) continue;
      const harness =
        request.harness === "claude-code" ? "Claude Code" : request.harness === "codex" ? "Codex" : "An agent";
      const requester = request.sessionName && request.harness ? `${harness} · ${request.sessionName}` : harness;
      const notification = options.createNotification({
        title: "Approval needed in Omni",
        body: `${requester}: ${actionText(request)} — ${reasonText(request.approvalReason)}`,
      });
      notification.on("click", () => options.openRequest(request.requestId));
      notifications.set(request.requestId, notification);
      notification.show();
    }
  };
  update(await options.requests.all(), false);
  const unsubscribe = options.requests.onChanged((requests) => {
    try {
      update(requests, true);
    } catch (error: unknown) {
      console.error("Failed to update agent request attention.", error);
    }
  });
  return () => {
    unsubscribe();
    for (const notification of notifications.values()) notification.close();
    notifications.clear();
  };
}
