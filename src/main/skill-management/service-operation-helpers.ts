import type { OperationPlan, OperationReceipt } from "../../shared/operations-ipc";
import type { SkillEffectStep, SkillResult } from "../../shared/skill-management-ipc";
import type { SkillOperationJournalRecord } from "../../application/skill-management-journal";
import { isExternalSkillIntent } from "../../shared/external-skill-intents";

export function createSkillManagementReceipt(
  result: SkillResult,
  record: SkillOperationJournalRecord,
): OperationReceipt {
  const { receipts: _receipts, ...summary } = result;
  return {
    operationId: result.operationId,
    kind: "skill-management",
    status: ["applied", "no-op", "restored"].includes(result.status) ? "applied" : "failed",
    appliedAt: record.updatedAt,
    displayTarget: isExternalSkillIntent(record.intent)
      ? `${record.intent.kind === "install-external-skill" ? "Install" : record.intent.kind === "merge-external-skill" ? "Merge" : "Update"} external skills · ${record.intent.sourceId}`
      : result.propagation
        ? `${record.intent.kind === "restore" ? "Restore" : "Update"} linked copies · ${result.propagation.source.artifactPath.split("/").at(-1)}`
        : record.intent.kind === "project-skill"
          ? (record.effect?.steps[0]?.plan.displayTarget ?? `${record.intent.action} · ${record.intent.rowId}`)
          : (record.effect?.scope.packageId ?? "Skill operation"),
    actions: [],
    git: { mode: "unavailable" },
    registered: null,
    children: result.receiptIds,
    skillManagement: summary,
    ...(record.actor.kind === "mcp" && result.receipts?.find((receipt) => receipt.externalSkill)?.provenance
      ? { provenance: result.receipts.find((receipt) => receipt.externalSkill)!.provenance }
      : {}),
    ...(record.actor.kind === "desktop" && record.actor.automatic
      ? { provenance: { approval: "automatic", reason: "automatique" } }
      : {}),
    ...(record.intent.kind === "restore" ? { restores: record.intent.operationId } : {}),
  };
}

export function stepFor(
  plan: OperationPlan,
  sourceId: string,
  packageId: string,
  artifactPath?: string,
): SkillEffectStep {
  const scope = { sourceId, packageId, ...(artifactPath ? { artifactPath } : {}), targets: [] };
  const files = plan.actions
    .filter((action) => action.kind === "write-file" || action.kind === "delete-file")
    .map((action) => ({
      rootId: sourceId,
      relativePath: action.relativePath,
      change:
        action.kind === "delete-file"
          ? ("delete" as const)
          : action.beforeHash
            ? ("change" as const)
            : ("add" as const),
      ...(action.byteLength === undefined ? {} : { byteLength: action.byteLength }),
      ...(action.diff === undefined ? {} : { diff: action.diff }),
      ...(action.beforeHash === undefined ? {} : { beforeHash: action.beforeHash }),
      ...(action.afterHash === undefined ? {} : { afterHash: action.afterHash }),
    }));
  return { stepId: plan.planId, scope, plan, bindingEffects: [], files };
}

export function actionFingerprint(plan: OperationPlan, rootId: string) {
  return plan.actions.map((action) => ({
    rootId,
    kind: action.kind,
    relativePath: action.relativePath,
    ...(action.beforeHash === undefined ? {} : { beforeHash: action.beforeHash }),
    ...(action.afterHash === undefined ? {} : { afterHash: action.afterHash }),
  }));
}

export function operationResult(receipt: OperationReceipt, sourceId: string): SkillResult {
  const failed = receipt.status === "failed";
  return {
    intentId: receipt.operationId,
    operationId: receipt.operationId,
    status: failed ? "failed" : "applied",
    source: { status: failed ? "failed" : receipt.skillMode === "create" ? "created" : "updated", sourceId },
    targets: [],
    receiptIds: [receipt.operationId],
    receipts: [receipt],
    issues: failed
      ? [
          {
            code: "write-failed",
            message: receipt.diagnostic ?? "The skill write failed and was rolled back where possible.",
            recoveryAction: "inspect-recovery",
          },
        ]
      : [],
    recoveryAvailable: failed,
  };
}
