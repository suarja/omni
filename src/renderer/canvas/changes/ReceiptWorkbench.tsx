import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { useEffect, useState, type ReactElement } from "react";

import type { DesktopApi } from "../../../shared/ipc";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { Card } from "../../components/ui/Card";
import { WorkflowFooter } from "./WorkflowFooter";
import { ItemList } from "../../components/ui/ItemList";
import { LoadingSkeleton } from "../../components/ui/Skeleton";
import { useI18n } from "../../i18n";
import type { Route } from "../../navigation";
import { isReceiptRestorable, operationLabel } from "../../review/CompletedOperations";
import { ReceiptDetails } from "../../operations/receipt-sections";

export type ReceiptWorkbenchProps = Readonly<{
  api: DesktopApi | null;
  operationId: string;
  returnTo: Route;
  onNavigateToRoute: (route: Route) => void;
}>;

function timeOf(timestamp: string): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayOf(timestamp: string, t: ReturnType<typeof useI18n>["t"]): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return t("receipt.today");
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t("receipt.yesterday");
  return date.toLocaleDateString();
}

function description(receipt: OperationReceipt, t: ReturnType<typeof useI18n>["t"], language: "en" | "fr"): string {
  const date = new Date(receipt.appliedAt).toLocaleDateString(language === "fr" ? "fr-FR" : "en-US");
  if (receipt.restored) return t("receipt.restoredDescription", { date });
  if (receipt.status === "failed")
    return t("receipt.failedDescription", { when: dayOf(receipt.appliedAt, t), time: timeOf(receipt.appliedAt) });
  return t("receipt.appliedDescription", {
    when: dayOf(receipt.appliedAt, t),
    time: timeOf(receipt.appliedAt),
    commit: receipt.git.commit ? t("receipt.commitSuffix", { commit: receipt.git.commit.slice(0, 7) }) : "",
  });
}

function restoreRoute(receipt: OperationReceipt): Route {
  if (receipt.kind === "skill-management") {
    const sourceId = receipt.skillManagement?.propagation?.source.sourceId;
    return {
      screen: "resource-canvas",
      context: sourceId ? { kind: "entry", entry: { kind: "source", id: sourceId } } : { kind: "workspace" },
      initialSkillRestoreOperationId: receipt.operationId,
    };
  }
  if ((receipt.kind === "apply-plan" || receipt.kind === "remove-binding") && receipt.project)
    return {
      screen: "resource-canvas",
      context: { kind: "entry", entry: { kind: "project", id: receipt.project.id } },
      initialSkillRestoreOperationId: receipt.operationId,
    };
  return { screen: "operation-restore", operationId: receipt.operationId };
}

export function ReceiptWorkbench({
  api,
  operationId,
  onNavigateToRoute,
  returnTo,
}: ReceiptWorkbenchProps): ReactElement {
  const { language, t } = useI18n();
  const [receipts, setReceipts] = useState<readonly OperationReceipt[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    if (!api?.listOperations) {
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    void api
      .listOperations()
      .then((response) => {
        if (active) {
          setReceipts(response.status === "ready" ? response.receipts : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [api]);
  const receipt = receipts.find((candidate) => candidate.operationId === operationId);
  if (!loaded)
    return (
      <WorkflowWorkbench
        title={
          receipt
            ? operationLabel(receipt, t, language)
            : t(loaded ? "receipt.unavailable" : "reviewExtras.completedTitle")
        }
        busy={false}
        subtitle={receipt ? description(receipt, t, language) : undefined}
        hasResult={Boolean(receipt)}
        onClose={() => onNavigateToRoute(returnTo)}
        api={api}
      >
        <div>
          <Card>
            <ItemList variant="nested">
              <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("receipt.files") })} />
            </ItemList>
          </Card>
        </div>
      </WorkflowWorkbench>
    );
  if (!receipt)
    return (
      <WorkflowWorkbench
        title={
          receipt
            ? operationLabel(receipt, t, language)
            : t(loaded ? "receipt.unavailable" : "reviewExtras.completedTitle")
        }
        busy={false}
        subtitle={receipt ? description(receipt, t, language) : undefined}
        hasResult={Boolean(receipt)}
        onClose={() => onNavigateToRoute(returnTo)}
        footer={
          <WorkflowFooter
            actions={<Button onClick={() => onNavigateToRoute(returnTo)}>{t("operations.backToReview")}</Button>}
          />
        }
        api={api}
      >
        <div>
          <Callout title={t("receipt.unavailable")} tone="warning">
            {operationId}
          </Callout>
        </div>
      </WorkflowWorkbench>
    );
  const restorable = isReceiptRestorable(receipt, receipts);
  return (
    <WorkflowWorkbench
      title={
        receipt
          ? operationLabel(receipt, t, language)
          : t(loaded ? "receipt.unavailable" : "reviewExtras.completedTitle")
      }
      busy={false}
      subtitle={receipt ? description(receipt, t, language) : undefined}
      hasResult={Boolean(receipt)}
      onClose={() => onNavigateToRoute(returnTo)}
      api={api}
    >
      <div data-testid="receipt-page">
        {receipt.status === "failed" && receipt.diagnostic ? (
          <Callout title={t("receipt.failed")} tone="error">
            {receipt.diagnostic}
          </Callout>
        ) : null}
        <ReceiptDetails api={api} onNavigateToRoute={onNavigateToRoute} receipt={receipt} receipts={receipts} />
        {receipt.restored ? (
          <WorkflowFooter note={t("receipt.restoredOn", { date: new Date(receipt.appliedAt).toLocaleDateString() })} />
        ) : restorable ? (
          <WorkflowFooter
            actions={
              <Button dataTestId="receipt-restore" onClick={() => onNavigateToRoute(restoreRoute(receipt))}>
                {t(receipt.kind === "register-project" ? "projectView.undo" : "receipt.restore")}
              </Button>
            }
          />
        ) : null}
      </div>
    </WorkflowWorkbench>
  );
}
