import type { ReactElement } from "react";
import { DeliveryReceipt } from "../canvas/delivery/DeliveryReceipt";

import type { OperationReceipt } from "../../shared/operations-ipc";
import { Card, CardHeader } from "../components/ui/Card";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { ReceiptFiles } from "./receipt-files";
import type { DesktopApi } from "../../shared/ipc";
import { operationLabel } from "../review/CompletedOperations";

function shortHash(hash: string | undefined): string {
  return hash ? hash.slice(0, 7) : "—";
}

export function ReceiptDetails({
  api,
  onNavigateToRoute,
  receipt,
  receipts,
}: Readonly<{
  api: DesktopApi | null;
  onNavigateToRoute?: (route: Route) => void;
  receipt: OperationReceipt;
  receipts: readonly OperationReceipt[];
}>): ReactElement {
  const { language, t } = useI18n();
  return (
    <>
      <DeliveryReceipt receipt={receipt} />
      <ReceiptFiles api={api} receipt={receipt} />
      {receipt.children?.length ? (
        <Card data-testid="receipt-children-card">
          <CardHeader title={t("receipt.children")} count={receipt.children.length} />
          <ItemList variant="nested">
            {receipt.children.map((child) =>
              (() => {
                const childReceipt = receipts.find((candidate) => candidate.operationId === child);
                return (
                  <ListItem
                    key={child}
                    name={
                      childReceipt
                        ? `${operationLabel(childReceipt, t, language)} · ${timeOf(childReceipt.appliedAt)}`
                        : t("receipt.notFound")
                    }
                    onClick={
                      childReceipt && onNavigateToRoute
                        ? () =>
                            onNavigateToRoute({
                              screen: "operation-receipt",
                              operationId: child,
                              returnTo: {
                                screen: "operation-receipt",
                                operationId: receipt.operationId,
                                returnTo: { screen: "review" },
                              },
                            })
                        : undefined
                    }
                  />
                );
              })(),
            )}
          </ItemList>
        </Card>
      ) : null}
      {receipt.manifests?.length ? (
        <Card data-testid="receipt-manifests-card">
          <CardHeader title={t("receipt.manifests")} count={receipt.manifests.length} />
          <ItemList variant="nested">
            {receipt.manifests.map((manifest) => (
              <ListItem
                key={manifest.relativePath}
                name={manifest.relativePath}
                sub={t("receipt.hashTransition", {
                  before: shortHash(manifest.beforeHash),
                  after: shortHash(manifest.afterHash),
                })}
              />
            ))}
          </ItemList>
        </Card>
      ) : null}
      {receipt.git.commit ? (
        <Card data-testid="receipt-git-card">
          <CardHeader title={t("receipt.git")} />
          <ItemList variant="nested">
            <ListItem name={t("receipt.commit", { hash: receipt.git.commit.slice(0, 7) })} />
          </ItemList>
        </Card>
      ) : null}
      {receipt.provenance ? (
        <Card data-testid="receipt-origin-card">
          <CardHeader title={t("receipt.origin")} />
          <ItemList variant="nested">
            <ListItem
              name={t("receipt.requestedBy", {
                harness: receipt.provenance.agent
                  ? receipt.provenance.agent.harness === "codex"
                    ? "Codex"
                    : "Claude Code"
                  : "Omni",
                session: receipt.provenance.agent?.sessionName ?? "—",
                reason: receipt.provenance.reason ?? "—",
              })}
              sub={
                receipt.provenance.approval === "automatic"
                  ? t("agentSettings.automatic")
                  : receipt.provenance.approval === "conversation"
                    ? t("receipt.consented")
                    : t("receipt.approved")
              }
            />
          </ItemList>
        </Card>
      ) : null}
    </>
  );
}

function timeOf(timestamp: string): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
