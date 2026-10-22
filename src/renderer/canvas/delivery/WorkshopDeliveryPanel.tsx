import { useRef, useState, type ReactElement } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationPlan, OperationReceipt } from "../../../shared/operations-ipc";
import type { WorkshopDeliveryRequest, WorkshopDeliveryStatus } from "../../../shared/workshop-delivery-ipc";
import { translateCount, useI18n } from "../../i18n";
import { DeliveryReceipt } from "./DeliveryReceipt";
import "./delivery.css";

export function WorkshopDeliveryPanel(
  props: Readonly<{
    status: WorkshopDeliveryStatus;
    api: Partial<DesktopApi> | null;
    onRefresh: () => void;
    onApplyingChange: (busy: boolean) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const { workshop, plugins } = props.status;
  async function preview(request: WorkshopDeliveryRequest): Promise<void> {
    if (locked.current || !props.api?.previewOperation) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await props.api.previewOperation(request);
      if (result.status !== "ready") throw new Error(result.diagnostic);
      setPlan(result.plan);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("delivery.unavailable"));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function apply(): Promise<void> {
    if (locked.current || !plan || !props.api?.applyOperation) return;
    locked.current = true;
    setBusy(true);
    props.onApplyingChange(true);
    setError(null);
    try {
      const result = await props.api.applyOperation({ planId: plan.planId, provenance: { approval: "omni" } });
      setReceipt(result.receipt);
      setPlan(null);
      props.onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("delivery.unavailable"));
    } finally {
      locked.current = false;
      setBusy(false);
      props.onApplyingChange(false);
    }
  }
  return (
    <div className="workshop-delivery-panel" aria-busy={busy}>
      {workshop ? (
        <section>
          <h3>{workshop.name}</h3>
          <p>
            <span className={`project-chip ${workshop.sync.status === "current" ? "" : "is-modified"}`}>
              {t(`delivery.sync.${workshop.sync.status}`)}
            </span>
          </p>
          {workshop.sync.ahead ? <p>{translateCount(t, "delivery.ahead", workshop.sync.ahead)}</p> : null}
          {workshop.sync.behind ? <p>{translateCount(t, "delivery.behindCommits", workshop.sync.behind)}</p> : null}
          {workshop.sync.diagnostic ? <p role="status">{workshop.sync.diagnostic}</p> : null}
          {workshop.sync.status !== "current" ? (
            <button
              className="canvas-secondary-button"
              type="button"
              disabled={busy || Boolean(plan) || !props.api?.previewOperation}
              onClick={() => void preview({ kind: "retry-workshop-push", sourceId: workshop.sourceId })}
            >
              {t("delivery.retry")}
            </button>
          ) : null}
        </section>
      ) : (
        <p>{t("delivery.noWorkshop")}</p>
      )}
      <section>
        <h3>{t("delivery.installations")}</h3>
        {plugins.behind ? <p>{translateCount(t, "delivery.pluginsBehind", plugins.behind)}</p> : null}
        {!plugins.installations.length ? <p>{t("delivery.none")}</p> : null}
        {(["claude-code", "codex"] as const).map((harness) => {
          const records = plugins.installations.filter((plugin) => plugin.harness === harness);
          if (!records.length) return null;
          return (
            <section key={harness}>
              <h4>{harness === "codex" ? "Codex" : "Claude Code"}</h4>
              {records.map((plugin, index) => (
                <div className="delivery-installation" key={`${plugin.name}:${index}`}>
                  <p>
                    <b>
                      {plugin.name}@{plugin.marketplace}
                    </b>{" "}
                    · {t(`delivery.${plugin.state}`)}
                  </p>
                  <p>
                    {t("delivery.version", {
                      installed: plugin.version ?? plugin.commit?.slice(0, 7) ?? "?",
                      pushed: plugin.expectedVersion ?? workshop?.sync.pushedCommit?.slice(0, 7) ?? "?",
                    })}
                  </p>
                  {plugin.scope ? (
                    <>
                      {plugin.commit && workshop?.sync.pushedCommit ? (
                        <p>
                          {t("delivery.revision", {
                            installed: plugin.commit.slice(0, 7),
                            pushed: workshop.sync.pushedCommit.slice(0, 7),
                          })}
                        </p>
                      ) : null}
                      <p>
                        {t("delivery.scope", { scope: plugin.scope })}
                        {plugin.projectPath ? ` · ${plugin.projectPath}` : ""}
                      </p>
                    </>
                  ) : null}
                  {plugin.diagnostic ? <p>{plugin.diagnostic}</p> : null}
                  {plugin.commands.map((command, index) => (
                    <pre key={index}>
                      <code>
                        {[command.executable, ...command.args].join(" ")}
                        {command.cwd ? `\n${command.cwd}` : ""}
                      </code>
                    </pre>
                  ))}
                </div>
              ))}
              {records.some((plugin) => plugin.state === "behind") ? (
                <button
                  className="canvas-secondary-button"
                  type="button"
                  disabled={busy || Boolean(plan) || !props.api?.previewOperation}
                  onClick={() => void preview({ kind: "update-workshop-plugins", harness })}
                >
                  {t("delivery.update")}
                </button>
              ) : null}
            </section>
          );
        })}
        {plugins.diagnostics.map((text) => (
          <p role="status" key={text}>
            {text}
          </p>
        ))}
      </section>
      {props.status.diagnostics.map((text) => (
        <p role="status" key={text}>
          {text}
        </p>
      ))}
      {plan ? (
        <section className="delivery-preview" data-testid="delivery-operation-preview">
          <h3>{t("delivery.preview")}</h3>
          {plan.notes?.map((note) => (
            <p key={note}>{note}</p>
          ))}
          <div className="delivery-actions">
            <button className="canvas-secondary-button" type="button" disabled={busy} onClick={() => setPlan(null)}>
              {t("delivery.cancel")}
            </button>
            <button
              className="canvas-secondary-button is-primary"
              type="button"
              disabled={busy || !props.api?.applyOperation}
              onClick={() => void apply()}
            >
              {t(busy ? "delivery.busy" : "delivery.approve")}
            </button>
          </div>
        </section>
      ) : null}
      {receipt ? <DeliveryReceipt receipt={receipt} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
