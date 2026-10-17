import { LoadingSkeleton } from "../components/ui/Skeleton";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { version } from "../../../package.json";
import { AGENT_HARNESSES, agentName, statusForHarness } from "../agents/agent-utils";
import type { AgentHarness, AgentStatus } from "../../shared/agents-ipc";
import type { AgentMaintenanceState } from "../../shared/agent-maintenance-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { useI18n } from "../i18n";
import { Glossary } from "../canvas/Glossary";
import { AnchoredFloating } from "../canvas/AnchoredFloating";
import { useOptionalCanvasToast } from "../canvas/CanvasToast";
import { agentRelativeTime } from "../review/agent-requests";
import { agentRowState } from "./agent-row-state";

type Floating = Readonly<{ kind: "connect" | "menu" | "disconnect"; harness: AgentHarness; anchor: HTMLElement }>;
export function AgentsCard(
  props: Readonly<{
    api: DesktopApi | null;
    status: AgentStatus | null;
    loaded: boolean;
    maintenance?: AgentMaintenanceState;
    onChanged?: () => Promise<void>;
    onApplyingChange?: (active: boolean) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const toast = useOptionalCanvasToast();
  const [floating, setFloating] = useState<Floating | null>(null);
  const [busy, setBusy] = useState<AgentHarness | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    if (floating)
      document
        .querySelector<HTMLElement>(
          floating.kind === "menu" ? ".agent-actions-floating button" : ".agent-actions-floating [data-agent-cancel]",
        )
        ?.focus();
  }, [floating?.kind, floating?.harness]);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => {
    if (!lock.current) {
      setFloating(null);
      floating?.anchor.focus();
    }
  };
  const ready = Boolean(props.api?.previewOperation && props.api?.applyOperation);
  async function apply(harness: AgentHarness, action: "connect" | "reinstall" | "disconnect"): Promise<void> {
    if (lock.current || !ready) return;
    lock.current = true;
    props.onApplyingChange?.(true);
    setBusy(harness);
    setError(null);
    try {
      const preview = await props.api!.previewOperation!({
        kind: action === "disconnect" ? "disconnect-agents" : "install-agents",
        harnesses: [harness],
        ...(action === "reinstall" ? { force: true } : {}),
      });
      if (preview.status !== "ready") throw new Error(preview.diagnostic);
      const result = await props.api!.applyOperation!({ planId: preview.plan.planId });
      if (result.status !== "applied") throw new Error(result.receipt.diagnostic ?? t("agentSettings.unavailable"));
      setFloating(null);
      const agent = agentName(harness);
      toast?.show({
        message: t(
          action === "connect"
            ? "agentSettings.connectedToast"
            : action === "reinstall"
              ? "agentSettings.reinstalled"
              : "agentSettings.disconnected",
          {
            agent,
            count: result.receipt.actions.filter(
              (action) => action.kind === "write-file" && action.status === "applied",
            ).length,
          },
        ),
        ...(action === "disconnect" ? { undo: () => undo(result.receipt.operationId, harness) } : {}),
      });
      await props.onChanged?.();
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : t("agentSettings.unavailable"));
    } finally {
      lock.current = false;
      props.onApplyingChange?.(false);
      setBusy(null);
    }
  }
  async function undo(operationId: string, harness: AgentHarness): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    props.onApplyingChange?.(true);
    setBusy(harness);
    try {
      const preview = await props.api!.previewOperation!({ kind: "restore-import", operationId });
      if (preview.status !== "ready") throw new Error(preview.diagnostic);
      const result = await props.api!.applyOperation!({ planId: preview.plan.planId });
      if (result.status !== "applied") throw new Error(result.receipt.diagnostic ?? t("agentSettings.unavailable"));
      await props.onChanged?.();
      toast?.show({ message: t("agentSettings.restored", { agent: agentName(harness) }) });
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : t("agentSettings.unavailable"));
    } finally {
      lock.current = false;
      props.onApplyingChange?.(false);
      setBusy(null);
    }
  }
  async function check(harness: AgentHarness): Promise<void> {
    setFloating(null);
    try {
      const status = (await props.api?.getAgentStatus?.()) ?? props.status;
      const observed = statusForHarness(status, harness);
      toast?.show({
        message: observed?.lastSeenAt
          ? t("agentSettings.called", { agent: agentName(harness), time: agentRelativeTime(observed.lastSeenAt, t) })
          : t("agentSettings.neverCalled", { agent: agentName(harness) }),
      });
    } catch {
      setError(t("agentsSetup.statusUnavailable"));
    }
  }
  const name = floating ? agentName(floating.harness) : "";
  return (
    <section className="sec settings-group settings-agents" data-testid="settings-agents">
      <h3>
        {t("settings.groups.agents")} <Glossary concept="connect" />
      </h3>
      {AGENT_HARNESSES.map((harness) => {
        const observed = statusForHarness(props.status, harness);
        const updating = props.maintenance?.updating.includes(harness) || busy === harness;
        const row = agentRowState(observed, Boolean(updating), props.status?.appVersion ?? version, t);
        return (
          <div className="item" key={harness} data-agent={harness}>
            <span className={`dot ${row.dot}`} aria-hidden="true" />
            <div className="grow">
              <b>{agentName(harness)}</b>
              <small>
                {props.loaded ? (
                  row.line
                ) : (
                  <LoadingSkeleton label={t("agentsSetup.activityChecking")} variant="inline" />
                )}
              </small>
            </div>
            {observed?.detected && !observed.registered ? (
              <button
                className="canvas-secondary-button is-small is-primary"
                type="button"
                disabled={!ready || Boolean(busy) || Boolean(updating)}
                data-testid={`settings-agent-connect-${harness}`}
                onClick={(event) => setFloating({ kind: "connect", harness, anchor: event.currentTarget })}
              >
                {t("agentSettings.connect")}
              </button>
            ) : observed?.detected && observed.registered ? (
              <button
                className="more"
                type="button"
                aria-label={t("agentSettings.more")}
                aria-expanded={floating?.harness === harness && floating.kind === "menu"}
                disabled={Boolean(busy) || Boolean(updating)}
                onClick={(event) => setFloating({ kind: "menu", harness, anchor: event.currentTarget })}
              >
                ⋯
              </button>
            ) : null}
          </div>
        );
      })}
      <span className="hint">{t("agentSettings.hint")}</span>
      {error ? <p role="alert">{error}</p> : null}
      {floating ? (
        <AnchoredFloating
          anchor={floating.anchor}
          testId={`settings-agent-${floating.kind}-confirmation`}
          kind={floating.kind === "menu" ? "menu" : "pop"}
          className={`agent-actions-floating ${floating.kind === "disconnect" ? "agent-disconnect-pop" : ""}`}
          busy={Boolean(busy)}
          label={t(
            floating.kind === "menu"
              ? "agentSettings.more"
              : floating.kind === "connect"
                ? "agentSettings.connectTitle"
                : "agentSettings.disconnectTitle",
            { agent: name },
          )}
          onClose={close}
        >
          {floating.kind === "menu" ? (
            <>
              <button role="menuitem" type="button" onClick={() => void check(floating.harness)}>
                <span>
                  {t("agentSettings.check")}
                  <small>{t("agentSettings.checkHint", { agent: name })}</small>
                </span>
              </button>
              <button
                role="menuitem"
                type="button"
                disabled={!ready}
                onClick={() => void apply(floating.harness, "reinstall")}
              >
                <span>
                  {t("agentSettings.reinstall")}
                  <small>{t("agentSettings.reinstallHint", { agent: name })}</small>
                </span>
              </button>
              <button
                role="menuitem"
                className="danger"
                type="button"
                disabled={!ready}
                onClick={() => setFloating({ ...floating, kind: "disconnect" })}
              >
                <span>
                  {t("agentSettings.disconnect")}
                  <small>{t("agentSettings.disconnectHint", { agent: name })}</small>
                </span>
              </button>
            </>
          ) : (
            <>
              <h4>
                {t(floating.kind === "connect" ? "agentSettings.connectTitle" : "agentSettings.disconnectTitle", {
                  agent: name,
                })}{" "}
                <Glossary concept="connect" />
              </h4>
              <p>
                {t(floating.kind === "connect" ? "agentSettings.connectCopy" : "agentSettings.disconnectCopy", {
                  agent: name,
                })}
              </p>
              <div className="project-sheet-actions">
                <button
                  className="canvas-secondary-button is-small"
                  type="button"
                  data-agent-cancel
                  disabled={Boolean(busy)}
                  onClick={close}
                >
                  {t("projectView.cancel")}
                </button>
                <button
                  className={`canvas-secondary-button is-small ${floating.kind === "connect" ? "is-primary" : "is-danger"}`}
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void apply(floating.harness, floating.kind === "connect" ? "connect" : "disconnect")}
                >
                  {t(floating.kind === "connect" ? "agentSettings.connect" : "agentSettings.disconnect")}
                </button>
              </div>
            </>
          )}
        </AnchoredFloating>
      ) : null}
    </section>
  );
}
