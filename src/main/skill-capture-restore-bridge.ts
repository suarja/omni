import { randomUUID } from "node:crypto";
import type { SkillManagementService } from "../application/skill-management";
import type { SkillPreview } from "../shared/skill-management-ipc";
import type { OperationReceipt, PreviewMarketplaceResponse, ApplyOperationResponse } from "../shared/operations-ipc";
import type { OperationStore } from "./operation-store";

export function createSkillCaptureRestoreBridge(
  getService: () => SkillManagementService,
  store: OperationStore,
): Readonly<{
  preview(receipt: OperationReceipt): Promise<PreviewMarketplaceResponse>;
  apply(planId: string): Promise<ApplyOperationResponse | undefined>;
}> {
  const plans = new Map<string, Extract<SkillPreview, { status: "ready" }>>();
  return {
    async preview(receipt) {
      const result = await getService().preview(
        { kind: "restore", operationId: receipt.operationId },
        { kind: "desktop" },
      );
      if (result.status !== "ready")
        return { status: "blocked", reason: "capture-link-restore-unavailable", diagnostic: result.reason };
      const planId = randomUUID();
      plans.set(planId, result);
      return {
        status: "ready",
        plan: {
          planId,
          kind: "restore-apply",
          displayTarget: receipt.displayTarget,
          actions: result.steps.flatMap((step) => step.plan.actions),
          git: { mode: "unavailable", warnings: [] },
        },
      };
    },
    async apply(planId) {
      const preview = plans.get(planId);
      if (!preview) return undefined;
      plans.delete(planId);
      const result = await getService().apply(preview.intentId, {
        kind: "desktop",
        effectFingerprint: preview.effectFingerprint,
        approvedAt: new Date().toISOString(),
      });
      const history = await store.read();
      const receipt =
        history.status === "ready"
          ? history.receipts.find((receipt) => receipt.operationId === result.operationId)
          : undefined;
      if (!receipt)
        throw new Error(
          `The capture-link restore receipt is unavailable (${result.status}): ${result.issues.map((issue) => issue.message).join(" ")}. Refresh History before retrying.`,
        );
      return { status: result.status === "restored" ? "applied" : "failed", receipt };
    },
  };
}
