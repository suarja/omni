import type { ReactElement } from "react";

import type { OperationReceipt } from "../../shared/operations-ipc";
import { Badge } from "../components/ui/Badge";
import { IconWrap } from "../components/ui/IconWrap";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingBoundary, LoadingSkeleton } from "../components/ui/Skeleton";
import { SectionHeading } from "../components/ui/SectionHeading";
import { tCount, useI18n } from "../i18n";
import type { Route } from "../navigation";
import { latestInstallAgentsReceiptId, receiptHarnessNames } from "../agents/agent-utils";

export function operationLabel(
  receipt: OperationReceipt,
  t: ReturnType<typeof useI18n>["t"],
  language: "en" | "fr",
): string {
  if (receipt.agentSetup) {
    const agents = receiptHarnessNames(receipt, language);
    return t(
      receipt.agentSetup.action === "update"
        ? "agentSettings.historyUpdate"
        : receipt.agentSetup.action === "reinstall"
          ? "agentSettings.historyReinstall"
          : receipt.agentSetup.action === "disconnect"
            ? "rail.operation.unregister"
            : "rail.operation.register",
      { agents, name: agents },
    );
  }
  if (receipt.kind === "bridge-skill-uses")
    return t("rail.bridge", {
      count: receipt.legacyBridge?.uses.length ?? Number(receipt.displayTarget.match(/\d+/)?.[0] ?? 0),
    });
  if (receipt.kind === "skill-management") {
    const propagation = receipt.skillManagement?.propagation;
    if (!propagation) return t("skillManagement.title");
    const action = t(receipt.restores ? "reviewExtras.restoreLinkedCopies" : "reviewExtras.updateLinkedCopies");
    return `${action} · ${propagation.source.artifactPath.split("/").at(-1) ?? propagation.source.artifactPath}`;
  }
  if (receipt.kind === "add-to-project") {
    const [skill, , project] = receipt.displayTarget.split(" → ");
    return t("operations.addToProject.reviewLabel", {
      skill: skill ?? receipt.displayTarget,
      project: project ?? "project",
    });
  }
  if (receipt.kind === "describe-plugin")
    return t("skillActions.historyDescribe", {
      name: receipt.displayTarget.split("/").at(-1) ?? receipt.displayTarget,
    });
  if (receipt.kind === "link-storefront") return `${t("storefronts.link")} ${receipt.displayTarget}`;
  if (receipt.kind === "archive-storefront") return `${t("projectView.undo")} ${receipt.displayTarget}`;
  if (receipt.kind === "register-project") return t("agents.registerProject", { name: receipt.displayTarget });
  if (receipt.kind === "archive-project") return t("agents.archiveProject", { name: receipt.displayTarget });
  if (receipt.kind === "create-marketplace") return t("reviewExtras.createMarketplace");
  if (receipt.kind === "restore-import") return t("reviewExtras.restoreImport");
  if (receipt.kind === "restore-add-to-project") {
    const [skill, , project] = receipt.displayTarget.split(" → ");
    return t("reviewExtras.restoreAddToProject", {
      skill: skill ?? receipt.displayTarget,
      project: project ?? "project",
    });
  }
  if (receipt.kind === "make-compatible") {
    const harness = receipt.harness === "codex" ? t("operations.harness.codex") : t("operations.harness.claudeCode");
    return t("reviewExtras.makeCompatible", { harness });
  }
  if (receipt.kind === "write-skill") {
    const name =
      receipt.actions
        .find((action) => action.relativePath.includes("/skills/"))
        ?.relativePath.split("/skills/")[1]
        ?.split("/")[0] ?? receipt.displayTarget;
    return t(receipt.skillMode === "update" ? "reviewExtras.updateSkill" : "reviewExtras.addSkill", { name });
  }
  if (receipt.kind === "register-mcp") {
    const harness = receipt.harness === "codex" ? t("operations.harness.codex") : t("operations.harness.claudeCode");
    return t(receipt.mcpAction === "disable" ? "reviewExtras.registerMcpDisable" : "reviewExtras.registerMcpEnable", {
      harness,
    });
  }
  if (receipt.kind === "install-agents")
    return t("agentsSetup.reviewLabel", { harnesses: receiptHarnessNames(receipt, language) });
  if (receipt.kind === "apply-plan") return t("operations.lifecycle.applyPlan");
  if (receipt.kind === "remove-binding") return t("operations.lifecycle.removeBinding");
  if (receipt.kind === "restore-apply") return t("operations.lifecycle.restoreApply");
  if (receipt.kind === "stop-process") return t("activity.processStopped");
  if (receipt.kind === "remove-worktree") return t("activity.worktreeRemoved");
  if (receipt.kind === "signal-process") {
    const key =
      receipt.signalAction === "kill"
        ? "reviewExtras.signalKill"
        : receipt.signalAction === "resume"
          ? "reviewExtras.signalResume"
          : "reviewExtras.signalPause";
    return t(key, { name: receipt.displayTarget });
  }
  if (receipt.kind === "renice-process") return t("reviewExtras.reniceProcess", { name: receipt.displayTarget });
  if (receipt.kind === "write-harness-setting") {
    const days = receipt.harnessSetting?.value ?? null;
    return days === null ? t("reviewExtras.harnessCleanupOff") : t("reviewExtras.harnessCleanupDays", { days });
  }
  return t("reviewExtras.importArtifact");
}

function operationIcon(receipt: OperationReceipt): "marketplace" | "plugin" | "restore" | "agent" | "folder" {
  if (receipt.kind === "create-marketplace") return "marketplace";
  if (
    receipt.kind === "restore-import" ||
    receipt.kind === "restore-apply" ||
    receipt.kind === "restore-add-to-project"
  )
    return "restore";
  if (receipt.kind === "remove-binding" || receipt.kind === "remove-worktree") return "folder";
  if (
    receipt.kind === "stop-process" ||
    receipt.kind === "signal-process" ||
    receipt.kind === "renice-process" ||
    receipt.kind === "register-mcp" ||
    receipt.kind === "install-agents" ||
    receipt.kind === "disconnect-agents" ||
    receipt.kind === "write-harness-setting"
  )
    return "agent";
  return "plugin";
}

function fileCount(receipt: OperationReceipt): number {
  return (
    receipt.files?.length ??
    receipt.actions.filter((action) => action.kind === "write-file" || action.kind === "delete-file").length
  );
}

function relativeDate(timestamp: string, t: ReturnType<typeof useI18n>["t"]): string {
  const days = Math.floor((Date.now() - new Date(timestamp).getTime()) / 86_400_000);
  if (days <= 0) return t("reviewExtras.relativeToday");
  if (days === 1) return t("reviewExtras.relativeYesterday");
  return t("reviewExtras.relativeDays", { count: days });
}

export function isReceiptRestorable(receipt: OperationReceipt, receipts: readonly OperationReceipt[]): boolean {
  if (receipt.kind === "link-storefront") return receipt.status === "applied" && !receipt.restored;
  if (receipt.kind === "archive-storefront") return false;
  if (receipt.kind === "register-project") return receipt.status === "applied" && !receipt.restored;
  if (receipt.kind === "archive-project") return false;
  if (receipt.publication?.state === "pushed" || receipt.publication?.state === "push-outcome-unknown") return false;
  if (receipt.kind === "disconnect-agents") return receipt.status === "applied" && !receipt.restored;
  if (receipt.kind === "skill-management") {
    if (
      receipt.restored ||
      !receipt.skillManagement ||
      ["applying", "no-op", "cancelled", "restored"].includes(receipt.skillManagement.status)
    )
      return false;
    if (receipt.skillManagement.status === "recovery-required") return true;
    if (/^(disable|enable|delete|install-agent|remove-agent) · /u.test(receipt.displayTarget))
      return receipt.skillManagement.targets.some((target) => ["applied", "removed"].includes(target.status));
    const children = (receipt.children ?? []).flatMap((id) => receipts.find((child) => child.operationId === id) ?? []);
    return children.length > 0 && children.some((child) => child.status === "applied" && !child.restored);
  }
  if (receipt.kind === "import-artifact" && receipt.children?.length && !receipt.restored)
    return receipt.children.some((childId) => {
      const child = receipts.find((candidate) => candidate.operationId === childId);
      return child && isReceiptRestorable(child, receipts);
    });
  if (receipt.status !== "applied" || receipt.restored === true) return false;
  if (receipt.externalSkill) return true;
  if (receipt.kind === "add-to-project") {
    return (receipt.children ?? []).every((childId) => {
      const child = receipts.find((candidate) => candidate.operationId === childId);
      return child !== undefined && isReceiptRestorable(child, receipts);
    });
  }
  const current = receipts.filter((candidate) => candidate.status === "applied" && candidate.restored !== true);
  if (receipt.kind === "register-mcp")
    return (
      current
        .filter((candidate) => candidate.kind === "register-mcp" && candidate.harness === receipt.harness)
        .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))[0]?.operationId === receipt.operationId
    );
  if (receipt.kind === "install-agents") return latestInstallAgentsReceiptId(current, receipt) === receipt.operationId;
  if (receipt.kind === "write-harness-setting")
    return (
      current
        .filter(
          (candidate) =>
            candidate.kind === "write-harness-setting" && candidate.harnessSetting?.key === receipt.harnessSetting?.key,
        )
        .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))[0]?.operationId === receipt.operationId
    );
  // Pause/resume/kill and renice are not restorable (D5): no reversible edit to offer.
  if (receipt.kind === "signal-process" || receipt.kind === "renice-process") return false;
  if (receipt.kind === "import-artifact" || receipt.kind === "make-compatible" || receipt.kind === "write-skill")
    return (
      current
        .filter(
          (candidate) =>
            candidate.kind === "import-artifact" ||
            candidate.kind === "make-compatible" ||
            candidate.kind === "write-skill",
        )
        .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))[0]?.operationId === receipt.operationId
    );
  if (!receipt.project) return false;
  return (
    current
      .filter(
        (candidate) =>
          (candidate.kind === "apply-plan" || candidate.kind === "remove-binding") &&
          candidate.project?.id === receipt.project?.id,
      )
      .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))[0]?.operationId === receipt.operationId
  );
}

function operationName(receipt: OperationReceipt, t: ReturnType<typeof useI18n>["t"], language: "en" | "fr"): string {
  if (
    receipt.kind === "install-agents" ||
    receipt.kind === "disconnect-agents" ||
    (receipt.kind === "skill-management" && receipt.skillManagement?.propagation)
  )
    return operationLabel(receipt, t, language);
  return `${operationLabel(receipt, t, language)} · ${receipt.displayTarget.split("/").at(-1) ?? receipt.displayTarget}`;
}

function operationSub(receipt: OperationReceipt, t: ReturnType<typeof useI18n>["t"], language: "en" | "fr"): string {
  if (receipt.skillManagement)
    return `${t(receipt.skillManagement.status === "recovery-required" ? "skillManagement.statusRecovery" : receipt.skillManagement.status === "no-op" ? "skillManagement.statusNoOp" : receipt.restored ? "skillManagement.statusRestored" : receipt.skillManagement.status === "partial" ? "skillManagement.statusPartial" : receipt.status === "failed" ? "skillManagement.statusFailed" : "skillManagement.statusApplied")} · ${relativeDate(receipt.appliedAt, t)}`;
  const processKinds = ["stop-process", "signal-process", "renice-process"];
  const parts = [
    processKinds.includes(receipt.kind)
      ? tCount("activity.processes", receipt.actions.length, {}, language)
      : tCount("operations.files", fileCount(receipt), {}, language),
    relativeDate(receipt.appliedAt, t),
  ];
  if (receipt.provenance?.agent)
    parts.push(
      t("reviewExtras.viaAgent", {
        harness:
          receipt.provenance.agent.harness === "codex"
            ? t("operations.harness.codex")
            : t("operations.harness.claudeCode"),
      }),
    );
  return parts.join(" · ");
}

export function CompletedOperations({
  language,
  loaded = true,
  onNavigateToRoute,
  receipts,
  title = "review.operationsTitle",
  testId = "review-completed-operations",
  t,
}: Readonly<{
  language: "en" | "fr";
  loaded?: boolean;
  onNavigateToRoute?: (route: Route) => void;
  receipts: readonly OperationReceipt[];
  title?: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  testId?: string;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const children = new Set(
    receipts.filter((receipt) => receipt.kind === "skill-management").flatMap((receipt) => receipt.children ?? []),
  );
  const ordered = receipts
    .filter((receipt) => !children.has(receipt.operationId))
    .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
  return (
    <section data-testid={testId}>
      <SectionHeading count={ordered.length} title={t(title)} />
      <LoadingBoundary
        loading={!loaded}
        label={t("canvas.loadingSurface", { surface: t("canvas.review") })}
        minHeight={216}
      >
        <ItemList>
          {!loaded ? (
            <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("canvas.review") })} />
          ) : ordered.length ? (
            ordered.map((receipt) => (
              <CompletedOperationRow
                key={receipt.operationId}
                language={language}
                onNavigateToRoute={onNavigateToRoute}
                receipt={receipt}
                t={t}
              />
            ))
          ) : (
            <ListItem dim name={t("reviewExtras.completedEmpty")} />
          )}
        </ItemList>
      </LoadingBoundary>
    </section>
  );
}

export function CompletedOperationRow({
  language,
  onNavigateToRoute,
  receipt,
  t,
}: Readonly<{
  language: "en" | "fr";
  onNavigateToRoute?: (route: Route) => void;
  receipt: OperationReceipt;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const skillManagementRoute = (): Route => {
    const result = receipt.kind === "skill-management" ? receipt.skillManagement : undefined;
    const exactLocation =
      result?.detachment?.location ??
      result?.link?.location ??
      result?.capture?.location ??
      (result?.resolution?.targets.length === 1 ? result.resolution.targets[0]?.location : undefined);
    const context = exactLocation
      ? { kind: "entry" as const, entry: { kind: "project" as const, id: exactLocation.projectId } }
      : result?.source.sourceId
        ? { kind: "entry" as const, entry: { kind: "source" as const, id: result.source.sourceId } }
        : result?.targets[0]
          ? { kind: "entry" as const, entry: { kind: "project" as const, id: result.targets[0].projectId } }
          : { kind: "workspace" as const };
    return {
      screen: "resource-canvas",
      context,
      initialSkillResultId: result?.intentId ?? receipt.operationId,
    };
  };
  return (
    <ListItem
      dataTestId={`review-operation-${receipt.operationId}`}
      leading={<IconWrap name={operationIcon(receipt)} size="sm" />}
      name={operationName(receipt, t, language)}
      sub={operationSub(receipt, t, language)}
      badges={
        receipt.status === "failed" ? (
          <Badge tone="bad" variant="status">
            {t("reviewExtras.failed")}
          </Badge>
        ) : receipt.restored ? (
          <Badge tone="neutral" variant="status">
            {t("reviewExtras.restored")}
          </Badge>
        ) : null
      }
      onClick={
        onNavigateToRoute
          ? () =>
              onNavigateToRoute(
                receipt.kind === "skill-management"
                  ? skillManagementRoute()
                  : {
                      screen: "operation-receipt",
                      operationId: receipt.operationId,
                      returnTo: { screen: "review" },
                    },
              )
          : undefined
      }
    />
  );
}
