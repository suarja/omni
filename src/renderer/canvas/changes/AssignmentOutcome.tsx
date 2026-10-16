import type { ReactElement } from "react";

import type { OperationReceipt } from "../../../shared/operations-ipc";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { Card, CardHeader } from "../../components/ui/Card";
import { WorkflowFooter } from "./WorkflowFooter";
import { ItemList, ListItem } from "../../components/ui/ItemList";
import { tCount, useI18n } from "../../i18n";
import type { Route } from "../../navigation";

export type AssignmentConflict = Readonly<{ projectId: string; bindingIds: readonly string[] }>;

export function AssignmentOutcome({
  applyRequested,
  conflictProject,
  error,
  failedReceipt,
  onNavigate,
  receipts,
  returnTo,
  savedCounts,
}: Readonly<{
  applyRequested: boolean;
  conflictProject: AssignmentConflict | null;
  error: string | null;
  failedReceipt: OperationReceipt | null;
  onNavigate: (route: Route) => void;
  receipts: readonly OperationReceipt[];
  returnTo: Route;
  savedCounts: { projects: number; harnesses: number } | null;
}>): ReactElement {
  const { language, t } = useI18n();
  const allApplied = receipts.length === savedCounts?.projects && receipts.length > 0;
  const title = applyRequested
    ? allApplied
      ? t("assignment.applied")
      : receipts.length > 0
        ? t("assignment.partiallyApplied")
        : error
          ? t("assignment.applyNotCompleted")
          : t("assignment.saved")
    : t("assignment.saved");
  const openReceipt = (receipt: OperationReceipt): void =>
    onNavigate({ screen: "operation-receipt", operationId: receipt.operationId, returnTo });
  return (
    <div className="changes-result" data-testid="assignment-result">
      <Card>
        <CardHeader
          title={`${title} · ${tCount("assignment.savedProjects", savedCounts?.projects ?? 0, {}, language)} · ${tCount("assignment.savedHarnesses", savedCounts?.harnesses ?? 0, {}, language)}`}
        />
      </Card>
      {receipts.length ? (
        <Card data-testid="assignment-apply-receipts">
          <CardHeader title={t("assignment.appliedReceipts")} />
          <ItemList>
            {receipts.map((receipt) => (
              <ListItem
                key={receipt.operationId}
                name={receipt.displayTarget}
                sub={receipt.operationId}
                onClick={() => openReceipt(receipt)}
              />
            ))}
          </ItemList>
        </Card>
      ) : null}
      {failedReceipt ? (
        <Card data-testid="assignment-failed-receipt">
          <CardHeader title={t("assignment.failedReceipt")} />
          <ItemList>
            <ListItem
              dataTestId="assignment-failed-receipt-open"
              name={failedReceipt.displayTarget}
              sub={failedReceipt.operationId}
              onClick={() => openReceipt(failedReceipt)}
            />
          </ItemList>
        </Card>
      ) : null}
      {conflictProject ? (
        <Callout title={t("assignment.conflictNeedsReview")} tone="warning">
          <Button
            dataTestId="assignment-resolve-conflict"
            onClick={() =>
              onNavigate({
                screen: "operation-apply",
                projectId: conflictProject.projectId,
                bindingIds: conflictProject.bindingIds,
              })
            }
          >
            {t("assignment.resolveConflict")}
          </Button>
        </Callout>
      ) : null}
      {error ? (
        <Callout title={t("operations.failed")} tone="error">
          {error}
        </Callout>
      ) : null}
      <WorkflowFooter
        actions={
          <>
            <Button dataTestId="assignment-review" onClick={() => onNavigate({ screen: "review" })}>
              {t("assignment.seeReview")}
            </Button>
            <Button onClick={() => onNavigate(returnTo)} tone="ghost">
              {t("operations.back")}
            </Button>
          </>
        }
      />
    </div>
  );
}
