import { useEffect, useState, type ReactElement } from "react";
import { renderRoute, type AppShellProps } from "./routes";
import { createCanvasSession } from "../canvas/spatial/canvas-session";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { useI18n } from "../i18n";
import type { RegistryError } from "../registry/registry-error";
import { agentRequestRoute } from "../review/agent-requests";
import { gatedFallbackRoute, isRouteGated, useFeatures } from "../features";

function BootstrapState({
  error,
  onRetry,
}: Readonly<{ error: RegistryError | null; onRetry: () => void }>): ReactElement {
  const { t } = useI18n();
  return (
    <EmptyState
      actions={
        error ? (
          <Button onClick={onRetry} size="small" tone="secondary">
            {t("bootstrap.retry")}
          </Button>
        ) : undefined
      }
      ariaLive="polite"
      busy={!error}
      className={`shell-state${error ? " shell-state--error" : ""}`}
      description={error?.message ?? t("bootstrap.loadingDescription")}
      icon={<Icon name="target" size={22} />}
      title={error ? t("bootstrap.loadFailedHeading") : t("bootstrap.loading")}
    >
      {error?.detail ? (
        <details>
          <summary>{t("errors.technicalDetails")}</summary>
          <code>{error.detail}</code>
        </details>
      ) : null}
    </EmptyState>
  );
}

function RegistryUnavailableState({
  diagnostic,
  onRetry,
}: Readonly<{ diagnostic: string; onRetry: () => void }>): ReactElement {
  const { t } = useI18n();
  return (
    <EmptyState
      actions={
        <Button onClick={onRetry} size="small" tone="secondary">
          {t("bootstrap.retry")}
        </Button>
      }
      ariaLive="polite"
      className="shell-state shell-state--error"
      description={diagnostic}
      icon={<Icon name="target" size={22} />}
      title={t("registry.registryUnavailable")}
    />
  );
}

export function AppShell(props: AppShellProps): ReactElement {
  const { t } = useI18n();
  const { features } = useFeatures();
  const [canvasSession] = useState(createCanvasSession);
  const route = props.route ?? { screen: "resource-canvas" as const, context: { kind: "workspace" as const } };
  const effectiveRoute = isRouteGated(route, features) ? gatedFallbackRoute(route) : route;
  useEffect(() => {
    let active = true;
    const unsubscribe = props.api?.onOpenAgentRequest?.((requestId) => {
      void props.api
        ?.listAgentRequests?.()
        .then((result) => {
          if (!active) return;
          const request = result.requests.find(
            (item) => item.requestId === requestId && item.status === "pending" && item.approval === "omni",
          );
          props.onNavigateToRoute(
            request
              ? agentRequestRoute(request)
              : { screen: "resource-canvas", context: { kind: "workspace" }, initialRailSurface: "review" },
          );
        })
        .catch(() => {
          if (active)
            props.onNavigateToRoute({
              screen: "resource-canvas",
              context: { kind: "workspace" },
              initialRailSurface: "review",
            });
        });
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [props.api, props.onNavigateToRoute]);
  return (
    <div className="app-shell app-shell--canvas">
      <main className="content-area content-area--canvas">
        <section className="page-content" aria-busy={props.registryBusy}>
          {props.registry?.status === "ready" ? (
            renderRoute(effectiveRoute, props.registry.registry, props, t, canvasSession)
          ) : props.registry?.status === "corrupt" ? (
            <RegistryUnavailableState diagnostic={props.registry.diagnostic} onRetry={props.onRetry} />
          ) : (
            <BootstrapState error={props.registryError} onRetry={props.onRetry} />
          )}
        </section>
      </main>
    </div>
  );
}
