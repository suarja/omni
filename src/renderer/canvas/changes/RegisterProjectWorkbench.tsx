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

export function RegisterProjectWorkbench(
  props: Readonly<{
    api: DesktopApi | null;
    requestId: string;
    onClose: () => void;
    onNavigate: (route: Route) => void;
    onProjectChanged?: (id: string) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const preview = useAgentRequestPreview(props.api, props.requestId);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const plan = preview.request?.plan;
  const registration = plan?.kind === "register-project" ? plan.projectRegistration : undefined;
  const apply = async (): Promise<void> => {
    if (locked.current || !props.api?.applyOperation || !registration) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    let authorization: Awaited<ReturnType<typeof authorizeAssignmentRequest>>;
    try {
      const fresh = await preview.refresh();
      if (!fresh || fresh.plan.kind !== "register-project") throw new Error(t("operations.unavailable"));
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
        if (result.receipt.project) props.onProjectChanged?.(result.receipt.project.id);
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
      title={t(registration?.action === "restore" ? "agents.restoreProject" : "agents.registerProject", {
        name: plan?.kind !== "assign" ? (plan?.displayTarget ?? "") : "",
      })}
      subtitle={registration?.path}
      api={props.api}
      busy={busy || preview.busy}
      onClose={props.onClose}
      hasResult={Boolean(receipt)}
      receipt={receipt}
      onNavigate={props.onNavigate}
      targets={<p>{t("agents.projectRegistrationEffect")}</p>}
      footer={
        !receipt ? (
          <WorkflowFooter
            note={t("operations.confirmNote")}
            actions={
              <Button
                dataTestId="register-project-approve"
                disabled={busy || preview.busy || !registration}
                onClick={() => void apply()}
              >
                {t("agents.registerProject", { name: "" })}
              </Button>
            }
          />
        ) : undefined
      }
    >
      <p>{t("agents.projectRegistrationEffect")}</p>
      {receipt ? <p>{t(receipt.status === "applied" ? "operations.applied" : "operations.failed")}</p> : null}
      {error || preview.error ? (
        <Callout title={t("operations.failed")} tone="error">
          {error ?? preview.error}
        </Callout>
      ) : null}
    </WorkflowWorkbench>
  );
}
