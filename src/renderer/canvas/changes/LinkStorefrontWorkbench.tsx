import { samePlan } from "../../../shared/agent-plan-freshness";
import { AgentPreviewUpdated } from "../../operations/AgentPreviewUpdated";
import { useRef, useState, type ReactElement } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import type { Route } from "../../navigation";
import { useI18n } from "../../i18n";
import { useAgentRequestPreview } from "../../operations/use-agent-request-preview";
import {
  authorizeAssignmentRequest,
  releaseAssignmentRequest,
  completeAssignmentRequest,
  recordAssignmentFailure,
} from "../../operations/assignment-agent-outcome";
import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { WorkflowFooter } from "./WorkflowFooter";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";

export function LinkStorefrontWorkbench(
  props: Readonly<{
    api: DesktopApi | null;
    requestId: string;
    onClose: () => void;
    onNavigate: (route: Route) => void;
    onMarketplaceChanged?: () => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const preview = useAgentRequestPreview(props.api, props.requestId);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const plan = preview.request?.plan;
  const registration =
    plan?.kind === "link-storefront" || plan?.kind === "archive-storefront" ? plan.storefrontLink : undefined;
  const title = registration?.action === "archive" ? t("projectView.undo") : t("storefronts.link");
  const apply = async (): Promise<void> => {
    if (locked.current || !props.api?.applyOperation || !registration) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    let authorization: Awaited<ReturnType<typeof authorizeAssignmentRequest>>;
    try {
      const fresh = await preview.refresh();
      if (!fresh || (fresh.plan.kind !== "link-storefront" && fresh.plan.kind !== "archive-storefront"))
        throw new Error(t("operations.unavailable"));
      if (plan && !samePlan(plan, fresh.plan)) return;
      authorization = await authorizeAssignmentRequest(props.api, props.requestId);
      const result = await props.api.applyOperation({
        planId: fresh.plan.planId,
        provenance: {
          approval: "omni",
          ...(fresh.harness
            ? {
                agent: {
                  harness: fresh.harness,
                  ...(fresh.sessionName ? { sessionName: fresh.sessionName } : {}),
                  requestedAt: fresh.createdAt,
                },
              }
            : {}),
        },
      });
      setReceipt(result.receipt);
      if (result.status === "applied") {
        await completeAssignmentRequest(props.api, props.requestId, [result.receipt], authorization);
        props.onMarketplaceChanged?.();
      } else {
        const message = result.receipt.diagnostic ?? t("operations.unavailable");
        await recordAssignmentFailure(props.api, props.requestId, [result.receipt], message, authorization);
        setError(message);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : t("operations.unavailable"));
    } finally {
      try {
        await releaseAssignmentRequest(props.api!, props.requestId, authorization);
      } catch {
        setError(t("operations.unavailable"));
      }
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <WorkflowWorkbench
      title={title}
      subtitle={registration?.path}
      api={props.api}
      busy={busy || preview.busy}
      onClose={props.onClose}
      hasResult={Boolean(receipt)}
      receipt={receipt}
      onNavigate={props.onNavigate}
      targets={<p>{registration?.inspection.githubRepository ?? registration?.path}</p>}
      footer={
        !receipt ? (
          <WorkflowFooter
            note={t("operations.confirmNote")}
            actions={
              <Button
                dataTestId="link-storefront-approve"
                disabled={busy || preview.busy || !registration}
                onClick={() => void apply()}
              >
                {title}
              </Button>
            }
          />
        ) : undefined
      }
    >
      <AgentPreviewUpdated visible={preview.updated} />
      {plan?.kind !== "assign" ? plan?.notes?.map((note) => <p key={note}>{note}</p>) : null}
      {registration?.inspection.plugins.map((plugin) => (
        <p key={plugin.pluginId}>
          {plugin.name}
          {plugin.origin
            ? `: ${plugin.origin.sourceRepository}/${plugin.origin.sourcePath} @ ${plugin.origin.sourceCommit}`
            : ""}
        </p>
      ))}
      {registration?.unlinkedPlugins.map((plugin) => (
        <p key={plugin.pluginId}>
          {plugin.pluginId}: {plugin.reason}
        </p>
      ))}
      {receipt ? <p>{t(receipt.status === "applied" ? "operations.applied" : "operations.failed")}</p> : null}
      {error || preview.error ? (
        <Callout title={t("operations.failed")} tone="error">
          {error ?? preview.error}
        </Callout>
      ) : null}
    </WorkflowWorkbench>
  );
}
