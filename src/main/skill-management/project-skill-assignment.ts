import type { SkillOperationJournal } from "../../application/skill-management-journal";
import type { SkillResult } from "../../shared/skill-management-ipc";
import type { OperationStore } from "../operation-store";
import type { OperationReceipt } from "../../shared/operations-ipc";

function linkAssignmentBridge(
  result: SkillResult,
  bridge: readonly OperationReceipt[],
  ids: readonly string[],
): SkillResult {
  const tracked = new Set(
    bridge
      .filter((receipt) => receipt.legacyBridge?.phase === "applied")
      .flatMap((receipt) => receipt.legacyBridge!.uses.map((use) => use.bindingId)),
  );
  const missing = ids.filter((id) => !tracked.has(id));
  const uncertain = bridge.some(
    (receipt) =>
      receipt.legacyBridge?.phase === "prepared" &&
      receipt.legacyBridge.uses.some((use) => missing.includes(use.bindingId)),
  );
  const trackingCode = "project-skill-tracking-incomplete";
  return {
    ...result,
    status: missing.length
      ? uncertain
        ? "recovery-required"
        : "partial"
      : result.status === "recovery-required"
        ? "partial"
        : result.status,
    recoveryAvailable: result.recoveryAvailable || missing.length > 0,
    receiptIds: [...new Set([...result.receiptIds, ...bridge.map((receipt) => receipt.operationId)])],
    receipts: [
      ...new Map([...(result.receipts ?? []), ...bridge].map((receipt) => [receipt.operationId, receipt])).values(),
    ],
    issues: [
      ...result.issues.filter((issue) => issue.code !== trackingCode),
      ...(missing.length
        ? result.targets
            .filter((target) => missing.includes(target.bindingId))
            .map((target) => ({
              code: trackingCode,
              message:
                "The agent copy was installed, but its managed tracking receipt is incomplete; inspect operation history before retrying.",
              projectId: target.projectId,
              relativePath: target.artifactPath,
              recoveryAction: "inspect-recovery" as const,
            }))
        : result.issues.filter((issue) => issue.code === trackingCode)),
    ],
  };
}

export function createProjectSkillAssignmentCompletion(
  args: Readonly<{ journal: SkillOperationJournal; operationStore: OperationStore }>,
): Readonly<{
  assignmentBindingIds(result: SkillResult): Promise<readonly string[] | undefined>;
  recordAssignmentBridge(result: SkillResult): Promise<SkillResult>;
  reconcileAssignmentBridges(): Promise<void>;
}> {
  const assignmentBindingIds = async (result: SkillResult): Promise<readonly string[] | undefined> => {
    const saved = await args.journal.read(result.intentId);
    if (
      saved.status !== "ready" ||
      saved.record.intent.kind !== "project-skill" ||
      saved.record.intent.action !== "install-agent"
    )
      return undefined;
    return result.targets.filter((target) => target.status === "applied").map((target) => target.bindingId);
  };
  const recordAssignmentBridge = async (result: SkillResult): Promise<SkillResult> => {
    const ids = await assignmentBindingIds(result);
    if (!ids?.length) return result;
    const history = await args.operationStore.read();
    const saved = await args.journal.read(result.intentId);
    if (history.status !== "ready" || saved.status !== "ready")
      throw new Error("The installed skill's tracking receipt is unavailable.");
    const parent = history.receipts.find((receipt) => receipt.operationId === result.operationId);
    if (!parent?.skillManagement) throw new Error("The installed skill's operation receipt is unavailable.");
    if (parent.restored) return result;
    const bridge = history.receipts.filter(
      (receipt) =>
        receipt.legacyBridge &&
        ["applied", "prepared"].includes(receipt.legacyBridge.phase) &&
        !receipt.restored &&
        receipt.legacyBridge.uses.every((use) => ids.includes(use.bindingId)) &&
        receipt.legacyBridge.uses.some((use) => ids.includes(use.bindingId)),
    );
    const linked = linkAssignmentBridge(result, bridge, ids);
    if (JSON.stringify(linked) === JSON.stringify(result)) return result;
    const { receipts: _receipts, ...summary } = linked;
    const stored = await args.operationStore.append({
      ...parent,
      status: linked.status === "applied" ? "applied" : "failed",
      children: linked.receiptIds,
      skillManagement: summary,
    });
    if (stored.status !== "ready") throw new Error("The installed skill's tracking receipt could not be linked.");
    await args.journal.write({
      ...saved.record,
      status: linked.status === "recovery-required" ? "recovery-required" : "terminal",
      result: linked,
    });
    return linked;
  };
  const reconcileAssignmentBridges = async (): Promise<void> => {
    const saved = await args.journal.list();
    const history = await args.operationStore.read();
    if (saved.status !== "ready" || history.status !== "ready") return;
    for (const record of saved.records) {
      const result = record.result;
      if (record.intent.kind !== "project-skill" || record.intent.action !== "install-agent" || !result) continue;
      if (!result.receipts?.some((receipt) => receipt.kind === "apply-plan")) continue;
      if (
        result.status !== "applied" &&
        !(
          ["partial", "recovery-required"].includes(result.status) &&
          result.issues.every((issue) => issue.code === "project-skill-tracking-incomplete")
        )
      )
        continue;
      await recordAssignmentBridge(result);
    }
  };
  return { assignmentBindingIds, recordAssignmentBridge, reconcileAssignmentBridges };
}
