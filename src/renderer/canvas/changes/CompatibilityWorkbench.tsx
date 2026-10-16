import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { useEffect, useRef, useState, type ReactElement } from "react";

import type { Observation, SourceEntryView } from "../../../domain/project-source-registry";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationPlan, OperationReceipt, PreviewMarketplaceResponse } from "../../../shared/operations-ipc";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { WorkflowFooter } from "./WorkflowFooter";
import { useI18n } from "../../i18n";
import type { Route } from "../../navigation";
import { ReportCard, ResultCard, WriteCard } from "../../operations/compatibility-cards";
import { samePlan } from "../../../shared/agent-plan-freshness";
import { useAgentRequestPreview } from "../../operations/use-agent-request-preview";
import { AgentPreviewUpdated } from "../../operations/AgentPreviewUpdated";
import { AgentRequestBanner } from "../../operations/AgentRequestBanner";

type Harness = "claude-code" | "codex";
type PreviewState =
  Readonly<{ kind: "ready"; plan: OperationPlan }> | Readonly<{ kind: "blocked"; reason: string; diagnostic: string }>;

export type CompatibilityWorkbenchProps = Readonly<{
  api: DesktopApi | null;
  harness: Harness;
  observation: Observation | null;
  onMarketplaceChanged: () => void;
  onNavigateToRoute: (route: Route) => void;
  packageId?: string;
  returnTo: Route;
  source: SourceEntryView;
  sourceGrantHandle?: string;
  requestId?: string;
}>;

function harnessLabel(harness: Harness, t: ReturnType<typeof useI18n>["t"]): string {
  return t(harness === "claude-code" ? "operations.harness.claudeCode" : "operations.harness.codex");
}

export function CompatibilityWorkbench({
  api,
  harness,
  observation,
  onMarketplaceChanged,
  onNavigateToRoute,
  packageId,
  returnTo,
  source,
  sourceGrantHandle,
  requestId,
}: CompatibilityWorkbenchProps): ReactElement {
  const { language, t } = useI18n();
  const agentPreview = useAgentRequestPreview(api, requestId);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null);
  const [appliedPlan, setAppliedPlan] = useState<OperationPlan | null>(null);
  const [appliedKeepUpdates, setAppliedKeepUpdates] = useState<readonly string[]>([]);
  const [keepUpdates, setKeepUpdates] = useState<readonly string[]>([]);
  const [expandedDiffs, setExpandedDiffs] = useState<Readonly<Record<string, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const targetName =
    observation?.inventory.packages?.find((packageInfo) => packageInfo.id === packageId)?.displayName ??
    packageId ??
    source.displayName;
  const marketplaceName =
    observation?.inventory.marketplace?.name ?? observation?.inventory.displayRoot ?? source.displayName;
  const targetHarness = harnessLabel(harness, t);

  useEffect(() => {
    const requestSequence = sequence.current + 1;
    sequence.current = requestSequence;
    if (receipt) return;
    if (requestId && !keepUpdates.length) {
      const plan = agentPreview.request?.plan;
      setPreview(plan && plan.kind !== "assign" ? { kind: "ready", plan } : null);
      setError(agentPreview.error);
      return;
    }
    if (!api?.previewOperation) {
      setError(t("operations.unavailable"));
      return;
    }
    if (!sourceGrantHandle) {
      setError(t("operations.compatible.grantUnavailable"));
      return;
    }
    setBusy(true);
    setError(null);
    setPreview(null);
    const previewOperation = api.previewOperation;
    const timer = window.setTimeout(() => {
      const request = {
        kind: "make-compatible" as const,
        sourceId: source.ref.id,
        ...(packageId ? { packageId } : {}),
        harness,
        ...(keepUpdates.length ? { keepUpdates } : {}),
      };
      void previewOperation(request)
        .then((result: PreviewMarketplaceResponse) => {
          if (sequence.current !== requestSequence) return;
          setPreview(
            result.status === "ready"
              ? { kind: "ready", plan: result.plan }
              : { kind: "blocked", reason: result.reason, diagnostic: result.diagnostic },
          );
        })
        .catch((previewError: unknown) => {
          if (sequence.current === requestSequence) {
            setError(previewError instanceof Error ? previewError.message : t("operations.unavailable"));
          }
        })
        .finally(() => {
          if (sequence.current === requestSequence) setBusy(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      sequence.current += 1;
    };
  }, [
    api,
    harness,
    keepUpdates,
    packageId,
    receipt,
    source.ref.id,
    sourceGrantHandle,
    t,
    requestId,
    agentPreview.request,
    agentPreview.error,
    agentPreview.busy,
  ]);

  const apply = async (): Promise<void> => {
    if (
      !api?.applyOperation ||
      preview?.kind !== "ready" ||
      preview.plan.actions.length === 0 ||
      busy ||
      agentPreview.busy
    )
      return;
    const planToApply = preview.plan;
    setBusy(true);
    setError(null);
    try {
      let currentPlan = planToApply;
      if (requestId && !keepUpdates.length) {
        const fresh = await agentPreview.refresh();
        if (!fresh || fresh.plan.kind === "assign") return;
        currentPlan = fresh.plan;
        if (!samePlan(planToApply, currentPlan)) {
          setPreview({ kind: "ready", plan: currentPlan });
          agentPreview.markUpdated();
          return;
        }
      }
      const result = await api.applyOperation({ planId: currentPlan.planId });
      setReceipt(result.receipt);
      setAppliedPlan(planToApply);
      setAppliedKeepUpdates(keepUpdates);
      setPreview(null);
      if (result.status === "applied") onMarketplaceChanged();
      if (result.status === "applied" && requestId)
        await api.resolveAgentRequest?.({ requestId, operationId: result.receipt.operationId });
    } catch (applyError: unknown) {
      setError(applyError instanceof Error ? applyError.message : t("operations.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const title = t("operations.compatible.heading", { target: targetName, harness: targetHarness });
  if (receipt && appliedPlan)
    return (
      <WorkflowWorkbench
        title={title}
        busy={busy || agentPreview.busy}
        hasResult={Boolean(receipt)}
        onClose={() => onNavigateToRoute(returnTo)}
        receipt={receipt}
        onNavigate={onNavigateToRoute}
        api={api}
      >
        <div data-testid="compatibility-page">
          <ResultCard
            keepUpdates={appliedKeepUpdates}
            language={language}
            onNavigateToRoute={onNavigateToRoute}
            plan={appliedPlan}
            receipt={receipt}
            returnTo={returnTo}
            t={t}
          />
        </div>
      </WorkflowWorkbench>
    );
  return (
    <WorkflowWorkbench
      title={title}
      busy={busy || agentPreview.busy}
      hasResult={Boolean(receipt)}
      onClose={() => onNavigateToRoute(returnTo)}
      receipt={receipt}
      onNavigate={onNavigateToRoute}
      targets={
        preview?.kind === "ready" ? (
          <ReportCard harness={harness} language={language} plan={preview.plan} t={t} />
        ) : null
      }
      footer={
        <WorkflowFooter
          actions={
            <Button
              dataTestId="compatibility-apply"
              disabled={
                busy || agentPreview.busy || !preview || preview.kind !== "ready" || preview.plan.actions.length === 0
              }
              onClick={() => void apply()}
            >
              {t("operations.compatible.apply")}
            </Button>
          }
          note={
            preview?.kind === "ready" && preview.plan.actions.length === 0
              ? t("operations.compatible.nothingToWrite", { harness: targetHarness })
              : t("operations.confirmNote")
          }
        />
      }
      api={api}
      notice={
        <>
          <AgentRequestBanner api={api} requestId={requestId} applying={busy || agentPreview.busy} />
          <AgentPreviewUpdated visible={agentPreview.updated} />
        </>
      }
    >
      <div data-testid="compatibility-page">
        {error ? (
          <Callout title={t("operations.compatible.previewUnavailable")} tone="error">
            {error}
          </Callout>
        ) : null}
        {preview?.kind === "blocked" ? (
          <Callout title={t("operations.compatible.previewBlocked")} tone="warning">
            {preview.reason}: {preview.diagnostic}
          </Callout>
        ) : null}
        {preview?.kind === "ready" ? (
          <>
            <WriteCard
              expandedDiffs={expandedDiffs}
              keepUpdates={keepUpdates}
              language={language}
              marketplaceName={marketplaceName}
              onKeepUpdate={(path, checked) =>
                setKeepUpdates((current) =>
                  checked ? [...current, path] : current.filter((currentPath) => currentPath !== path),
                )
              }
              onToggleDiff={(key) => setExpandedDiffs((current) => ({ ...current, [key]: !current[key] }))}
              plan={preview.plan}
              t={t}
            />
          </>
        ) : null}
      </div>
    </WorkflowWorkbench>
  );
}
