import { LoadingBoundary } from "../../components/ui/Skeleton";
import { routeForCanvasPage } from "../pages/page-navigation";
import { activeWorkshop } from "../../../domain/source-roles";
import {
  historyDay,
  historyTitle,
  historyLocation,
  historyProvenance,
  historyAttribution,
  historyTime,
} from "./history-view-model";
import { useEffect, useState, type ReactElement } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import { useI18n } from "../../i18n";
import { useReviewRevision } from "../../review/use-review-revision";
import { isReceiptRestorable } from "../../review/CompletedOperations";
import { AgentActivityOverview } from "../../activity/AgentActivityOverview";
import { AgentsView } from "../../activity/AgentsView";
import { AgentSessionView } from "../../activity/AgentSessionView";
import { WorktreesView } from "../../activity/WorktreesView";
import { HarnessSettingPage } from "../../operations/HarnessSettingPage";
import { isRouteGated } from "../../features";
import { useFeatures } from "../../features";
import type { Route } from "../../navigation";
import { SheetFrame } from "../SheetFrame";
import { useCanvasRail } from "./rail-context";

function orderedReceipts(receipts: readonly OperationReceipt[]): readonly OperationReceipt[] {
  const children = new Set(
    receipts.filter((receipt) => Boolean(receipt.children?.length)).flatMap((receipt) => receipt.children ?? []),
  );
  return receipts
    .filter((receipt) => !children.has(receipt.operationId))
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}
export function RailHistorySheet(): ReactElement | null {
  const rail = useCanvasRail();
  const { language, t } = useI18n();
  const { features } = useFeatures();
  const api = (rail?.canvas.railServices?.api ?? rail?.canvas.api ?? null) as DesktopApi | null;
  const revision = useReviewRevision(api);
  const [receipts, setReceipts] = useState<readonly OperationReceipt[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityRoute, setActivityRoute] = useState<Route>({ screen: "activity" });
  useEffect(() => {
    let active = true;
    setState("loading");
    if (!api?.listOperations) {
      setState("error");
      return;
    }
    void api
      .listOperations()
      .then((response) => {
        if (!active) return;
        if (response.status !== "ready") {
          setState("error");
          return;
        }
        setReceipts(response.receipts);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [api, revision]);
  if (!rail) return null;
  function resultPage(
    receipt: OperationReceipt,
  ): Pick<Extract<Route, { screen: "resource-canvas" }>, "screen" | "context" | "canvasPage"> {
    const children = receipts.filter((child) => receipt.children?.includes(child.operationId));
    const sourceId =
      receipt.externalSkill?.sourceId ??
      children.find((child) => child.externalSkill)?.externalSkill?.sourceId ??
      receipt.skillManagement?.source.sourceId;
    const personal = rail && activeWorkshop(rail.canvas.snapshot.registry);
    if (sourceId && personal?.ref.id === sourceId && personal.availability === "available")
      return routeForCanvasPage({ kind: "marketplace" });
    return sourceId && rail?.externalLibrary.list?.sources.some((source) => source.id === sourceId)
      ? routeForCanvasPage({ kind: "source", sourceId })
      : { screen: "resource-canvas", context: { kind: "workspace" } };
  }
  function openResult(receipt: OperationReceipt): void {
    if (receipt.kind === "skill-management") {
      rail?.close();
      rail?.canvas.onNavigate({
        ...resultPage(receipt),
        initialSkillResultId: receipt.skillManagement?.intentId ?? receipt.operationId,
      });
    } else {
      rail?.close();
      rail?.canvas.onNavigate({
        screen: "operation-receipt",
        operationId: receipt.operationId,
        returnTo: { screen: "resource-canvas", context: { kind: "workspace" }, initialRailSurface: "activity" },
      });
    }
  }
  function undo(receipt: OperationReceipt): void {
    if (
      receipt.externalSkill ||
      receipt.kind === "skill-management" ||
      receipt.kind === "apply-plan" ||
      receipt.kind === "remove-binding"
    ) {
      rail?.close();
      rail?.canvas.onNavigate({
        ...resultPage(receipt),
        initialSkillRestoreOperationId: receipt.operationId,
      });
    } else {
      rail?.close();
      rail?.canvas.onNavigate({ screen: "operation-restore", operationId: receipt.operationId });
    }
  }
  function navigate(route: Route): void {
    if (isRouteGated(route, features)) return;
    if (route.screen === "operation-receipt") {
      const receipt = receipts.find((item) => item.operationId === route.operationId);
      if (receipt) openResult(receipt);
    } else if (route.screen.startsWith("activity") || route.screen === "worktree-cleanup") setActivityRoute(route);
    else if (route.screen === "review") {
      rail?.close();
    } else {
      rail?.close();
      rail?.canvas.onNavigate(route);
    }
  }
  const ordered = orderedReceipts(receipts);
  const renderRow = (receipt: OperationReceipt): ReactElement => {
    return (
      <div
        className="rail-item"
        key={receipt.operationId}
        data-operation-id={receipt.operationId}
        onClick={() => openResult(receipt)}
      >
        <button
          type="button"
          data-testid={`canvas-history-operation-${receipt.kind}-${receipt.operationId}`}
          className="rail-history-entry"
        >
          <strong>{historyTitle(receipt, t, language, rail.canvas.snapshot, receipts)}</strong>
          <small>
            {historyLocation(receipt, rail.canvas.snapshot, language, receipts)} ·{" "}
            {historyAttribution(receipt, receipts, t)}
          </small>
          {receipt.publication ? (
            <small>
              {t(
                receipt.publication.state === "pushed"
                  ? "storefronts.pushed"
                  : receipt.publication.state === "committed-not-pushed"
                    ? "storefronts.notPushed"
                    : receipt.publication.state === "push-outcome-unknown"
                      ? "storefronts.pushUnknown"
                      : "reviewExtras.failed",
              )}
            </small>
          ) : null}
          {receipt.status === "failed" || receipt.restored ? (
            <small>{t(receipt.restored ? "reviewExtras.restored" : "reviewExtras.failed")}</small>
          ) : null}
        </button>
        <time dateTime={receipt.appliedAt}>{historyTime(receipt.appliedAt, t, language)}</time>
        {isReceiptRestorable(receipt, receipts) ? (
          <button
            className="canvas-secondary-button"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              undo(receipt);
            }}
          >
            {t("projectView.undo")}
          </button>
        ) : null}
      </div>
    );
  };
  return (
    <SheetFrame
      title={t("canvas.activity")}
      kicker={t("canvas.activity")}
      subtitle={t("rail.historyDescription")}
      testId="canvas-history-sheet"
      busy={false}
      onClose={rail.close}
    >
      <LoadingBoundary
        loading={state === "loading"}
        label={t("canvas.loadingSurface", { surface: t("canvas.review") })}
        minHeight={216}
      >
        {state === "error" ? (
          <p role="alert">{t("rail.historyUnavailable")}</p>
        ) : !ordered.length ? (
          <p>{t("rail.historyEmpty")}</p>
        ) : (
          [...new Set(ordered.map((receipt) => historyDay(receipt.appliedAt, t, language)))].map((day) => (
            <section className="rail-section" key={day}>
              <h3>{day}</h3>
              {ordered.filter((receipt) => historyDay(receipt.appliedAt, t, language) === day).map(renderRow)}
            </section>
          ))
        )}
      </LoadingBoundary>
      <details className="rail-section">
        <summary>{t("rail.appliedByAgents")}</summary>
        {ordered
          .filter((receipt) => receipt.status === "applied" && historyProvenance(receipt, receipts)?.agent)
          .map(renderRow)}
      </details>
      {features.activityAgents ? (
        <details className="rail-section" onToggle={(event) => setActivityOpen(event.currentTarget.open)}>
          <summary>{t("rail.agentActivity")}</summary>
          {activityRoute.screen !== "activity" ? (
            <button
              className="canvas-secondary-button"
              type="button"
              onClick={() => setActivityRoute({ screen: "activity" })}
            >
              {t("canvas.back")}
            </button>
          ) : null}
          {activityOpen ? <AgentActivity api={api} route={activityRoute} navigate={navigate} /> : null}
        </details>
      ) : null}
    </SheetFrame>
  );
}
function AgentActivity(
  props: Readonly<{ api: DesktopApi | null; route: Route; navigate: (route: Route) => void }>,
): ReactElement {
  const { api, route, navigate } = props;
  if (route.screen === "activity-agents") return <AgentsView api={api} onNavigateToRoute={navigate} />;
  if (route.screen === "activity-agent")
    return <AgentSessionView api={api} sessionId={route.sessionId} onNavigateToRoute={navigate} />;
  if (route.screen === "activity-worktrees")
    return <WorktreesView api={api} projectId={route.projectId} onNavigateToRoute={navigate} />;
  if (route.screen === "worktree-cleanup")
    return <HarnessSettingPage api={api} returnTo={route.returnTo} onNavigateToRoute={navigate} />;
  return <AgentActivityOverview api={api} onNavigateToRoute={navigate} />;
}
