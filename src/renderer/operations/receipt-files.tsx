import { LoadingSkeleton } from "../components/ui/Skeleton";
import { useEffect, useState, type ReactElement } from "react";

import type { DesktopApi } from "../../shared/ipc";
import type { OperationActionReceipt, OperationReceipt, ReceiptDiffResponse } from "../../shared/operations-ipc";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { Callout } from "../components/ui/Callout";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { UnifiedDiff } from "./lifecycle-ui";
import { formatByteSize } from "./operations-import-plan";
import { useI18n } from "../i18n";

function actionLabel(action: OperationActionReceipt, t: ReturnType<typeof useI18n>["t"]): string {
  if (action.kind === "create-directory") return t("receipt.folderCreated");
  if (action.kind === "delete-directory") return t("receipt.folderRemoved");
  if (action.kind === "delete-file") return t("receipt.deleted");
  return action.beforeHash ? t("receipt.modified") : t("receipt.added");
}

function actionStatus(action: OperationActionReceipt, t: ReturnType<typeof useI18n>["t"]): ReactElement | null {
  if (action.status === "applied") return null;
  return (
    <Badge tone="bad" variant="status">
      {action.status === "rolled-back" ? t("receipt.rolledBack") : t("receipt.failed")}
    </Badge>
  );
}

function DiffContent({
  api,
  operationId,
  relativePath,
}: Readonly<{ api: DesktopApi | null; operationId: string; relativePath: string }>): ReactElement {
  const { t } = useI18n();
  const [state, setState] = useState<"loading" | ReceiptDiffResponse>("loading");
  useEffect(() => {
    if (!api?.getReceiptDiff) return;
    let active = true;
    void api
      .getReceiptDiff({ operationId, relativePath })
      .then((result) => {
        if (active) setState(result);
      })
      .catch(() => {
        if (active) setState({ status: "unavailable", reason: t("receipt.diffUnavailable") });
      });
    return () => {
      active = false;
    };
  }, [api, operationId, relativePath, t]);
  if (state === "loading") {
    return <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("receipt.files") })} variant="document" />;
  }
  if (state.status === "unavailable") return <span>{state.reason}</span>;
  return (
    <>
      {state.after?.changedSince ? (
        <Callout title={t("receipt.changedSinceTitle")} tone="info">
          {t("receipt.changedSince")}
        </Callout>
      ) : null}
      <UnifiedDiff text={state.diff.text} truncated={state.diff.truncated} />
    </>
  );
}

function FileRow({
  action,
  api,
  operationId,
  t,
}: Readonly<{
  action: OperationActionReceipt;
  api: DesktopApi | null;
  operationId: string;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const canDiff = action.kind === "write-file" || action.kind === "delete-file";
  const size = action.byteLength === undefined ? undefined : formatByteSize(action.byteLength);
  return (
    <div className="receipt-file-row" data-testid={`receipt-file-${action.relativePath}`}>
      <ItemList variant="nested">
        <ListItem
          name={action.relativePath}
          sub={[actionLabel(action, t), size ? t("receipt.size", { size }) : undefined].filter(Boolean).join(" · ")}
          side={actionStatus(action, t)}
        />
      </ItemList>
      {canDiff ? (
        <div className="receipt-file-row__diff">
          <Button
            ariaExpanded={expanded}
            dataTestId={`receipt-diff-toggle-${action.relativePath.replaceAll("/", "-")}`}
            onClick={() => setExpanded((current) => !current)}
            size="small"
            tone="ghost"
          >
            {t(expanded ? "receipt.hideDiff" : "receipt.showDiff")}
          </Button>
          {expanded ? <DiffContent api={api} operationId={operationId} relativePath={action.relativePath} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ReceiptFiles({
  api,
  receipt,
}: Readonly<{ api: DesktopApi | null; receipt: OperationReceipt }>): ReactElement {
  const { t } = useI18n();
  return (
    <Card data-testid="receipt-files-card">
      <CardHeader title={t("receipt.files")} count={receipt.actions.length} />
      {receipt.actions.map((action) => (
        <FileRow
          action={action}
          api={api}
          key={`${action.kind}:${action.relativePath}`}
          operationId={receipt.operationId}
          t={t}
        />
      ))}
    </Card>
  );
}
