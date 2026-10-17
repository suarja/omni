import { useReviewRevision } from "./use-review-revision";
import { useEffect, useState, type ReactElement } from "react";

import type { AgentRequest, ApprovalReason } from "../../shared/agents-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { Callout } from "../components/ui/Callout";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { SectionHeading } from "../components/ui/SectionHeading";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { resolveCanvasRoute } from "../canvas-route";

export function agentApprovalReason(
  reason: ApprovalReason | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string | undefined {
  if (!reason) return undefined;
  if (reason.code === "public-publication") return t("storefronts.publicReason");
  if (reason.code === "deletes-files")
    return t(reason.count === 1 ? "agents.reason.deletesFiles.one" : "agents.reason.deletesFiles.other", {
      count: reason.count,
    });
  return t(`agents.reason.${reason.code}`);
}

// The stored plan names the marketplace the way the user knows it; the request only has its id.
function targetName(request: AgentRequest): string {
  return request.plan.kind === "assign" ? "" : request.plan.displayTarget;
}
export function agentRequestAction(request: AgentRequest, t: ReturnType<typeof useI18n>["t"]): string {
  if (request.request.kind === "link-storefront") return t("storefronts.link");
  if (request.request.kind === "register-project") return t("agents.registerProject", { name: targetName(request) });
  if (request.request.kind === "install-external-skill")
    return t("agents.assign", { artifact: request.request.skillName });
  if (request.request.kind === "publish-plugin")
    return t("storefronts.agentAction", { plugin: request.request.pluginId });
  if (request.request.kind === "remove-skill") return t("skillManagement.removeReview");
  if (request.request.kind === "restore-skill") return t("skillManagement.restoreReview");
  if (request.request.kind === "make-compatible")
    return t("agents.makeCompatible", {
      package: request.request.packageId ?? targetName(request),
      harness: agentHarnessName(request.request.harness) ?? request.request.harness,
    });
  if (request.request.kind === "assign") return t("agents.assign", { artifact: request.request.artifactPath });
  if (request.request.kind === "write-skill") return t("agents.writeSkill", { name: request.request.folderName });
  if (request.request.kind === "update-and-maintain")
    return t("skillManagement.agentUpdateAndMaintain", { name: request.request.request.folderName });
  if (request.request.kind === "maintain-current")
    return t("skillManagement.agentMaintainCurrent", {
      name: request.request.source.artifactPath.split("/").at(-1) ?? request.request.source.artifactPath,
    });
  return t("agents.capture", { path: request.request.relativePath });
}
// Who asked, in words: "Claude Code · iterative-sprouting-lamport", "Codex", or "An agent" when
// the caller could not be linked to a session (no false attribution).
export function agentHarnessName(harness: AgentRequest["harness"]): string | undefined {
  return harness === "claude-code" ? "Claude Code" : harness === "codex" ? "Codex" : undefined;
}
export function agentRequesterLabel(request: AgentRequest, t: ReturnType<typeof useI18n>["t"]): string {
  const harness = agentHarnessName(request.harness);
  if (!harness) return t("agents.unknownSession");
  return request.sessionName ? `${harness} · ${request.sessionName}` : harness;
}
export function agentRelativeTime(createdAt: string, t: ReturnType<typeof useI18n>["t"], now = Date.now()): string {
  const age = Math.max(0, now - new Date(createdAt).getTime());
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return t("agents.justNow");
  if (minutes < 60) return t("agents.minutesAgo", { count: minutes });
  return t("agents.hoursAgo", { count: Math.floor(minutes / 60) });
}
export function agentRequestRoute(request: AgentRequest): Route {
  if (request.request.kind === "link-storefront" || request.plan.kind === "archive-storefront")
    return resolveCanvasRoute({ screen: "operation-link-storefront", requestId: request.requestId })!;
  if (request.request.kind === "register-project")
    return resolveCanvasRoute({ screen: "operation-register-project", requestId: request.requestId })!;
  if (request.request.kind === "publish-plugin")
    return { screen: "resource-canvas", context: { kind: "workspace" }, initialPublicationRequest: request };
  if (request.skillIntent)
    return {
      screen: "resource-canvas",
      context: { kind: "workspace" },
      initialSkillIntent: request.skillIntent,
      ...(request.intentId ? { initialSkillIntentId: request.intentId } : {}),
      requestId: request.requestId,
    };
  if (request.request.kind === "make-compatible")
    return resolveCanvasRoute({
      screen: "operation-compatible",
      sourceId: request.request.sourceId,
      ...(request.request.packageId ? { packageId: request.request.packageId } : {}),
      harness: request.request.harness,
      returnTo: { screen: "review" },
      requestId: request.requestId,
    })!;
  if (request.request.kind === "assign")
    return resolveCanvasRoute({
      screen: "assignment",
      sourceId: request.request.sourceId,
      packageId: request.request.packageId,
      artifactPath: request.request.artifactPath,
      returnTo: { screen: "review" },
      requestId: request.requestId,
    })!;
  if (request.request.kind === "write-skill")
    return {
      screen: "resource-canvas",
      context: { kind: "entry", entry: { kind: "source", id: request.request.sourceId } },
      initialSkillRequest: request.request,
      requestId: request.requestId,
    };
  if (request.request.kind === "import-artifact")
    return resolveCanvasRoute({
      screen: "operation-import",
      source: { kind: "project", id: request.request.projectId },
      relativePath: request.request.relativePath,
      returnTo: { screen: "review" },
      requestId: request.requestId,
    })!;
  const intent =
    request.request.kind === "remove-skill"
      ? { kind: "remove" as const, bindingIds: request.request.bindingIds }
      : request.request.kind === "restore-skill"
        ? { kind: "restore" as const, operationId: request.request.operationId }
        : request.request;
  return {
    screen: "resource-canvas",
    context: { kind: "workspace" },
    initialSkillIntent: intent,
    requestId: request.requestId,
  };
}

type AgentRequestsState = Readonly<{ requests: readonly AgentRequest[]; loading: boolean; error: boolean }>;

type AgentRequestsApi = Partial<Pick<DesktopApi, "listAgentRequests" | "onReviewChanged">>;

export function useOmniAgentRequestsState(api: AgentRequestsApi | null): AgentRequestsState {
  const revision = useReviewRevision(api);
  const [state, setState] = useState<AgentRequestsState>({
    requests: [],
    loading: Boolean(api?.listAgentRequests),
    error: false,
  });
  useEffect(() => {
    let active = true;
    if (!api?.listAgentRequests) {
      setState({ requests: [], loading: false, error: false });
      return () => {
        active = false;
      };
    }
    void api
      .listAgentRequests()
      .then((result) => {
        if (active)
          setState({
            requests: result.requests.filter((request) => request.approval === "omni" && request.status === "pending"),
            loading: false,
            error: false,
          });
      })
      .catch(() => {
        if (active) setState({ requests: [], loading: false, error: true });
      });
    return () => {
      active = false;
    };
  }, [api, revision]);
  return state;
}

export function useOmniAgentRequests(api: AgentRequestsApi | null): readonly AgentRequest[] {
  return useOmniAgentRequestsState(api).requests;
}

export function AgentRequestsError({ t }: Readonly<{ t: ReturnType<typeof useI18n>["t"] }>): ReactElement {
  return (
    <Callout title={t("reviewExtras.requestsUnavailable")} tone="error">
      {t("reviewExtras.requestsRecovery")}
    </Callout>
  );
}

export function AgentRequestRow({
  onNavigate,
  request,
  t,
}: Readonly<{
  onNavigate?: (route: Route) => void;
  request: AgentRequest;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  return (
    <ListItem
      dataTestId={`agent-request-${request.requestId}`}
      name={`${agentRequesterLabel(request, t)} ${t("agents.asks")}`}
      sub={
        <>
          <span>{`${agentRequestAction(request, t)} · ${agentRelativeTime(request.createdAt, t)}`}</span>
          {request.approvalReason ? (
            <>
              <br />
              <span>{agentApprovalReason(request.approvalReason, t)}</span>
            </>
          ) : null}
        </>
      }
      onClick={() => onNavigate?.(agentRequestRoute(request))}
    />
  );
}

export function AgentRequests({
  api,
  onNavigate,
}: Readonly<{ api: DesktopApi | null; onNavigate?: (route: Route) => void }>): ReactElement | null {
  const { t } = useI18n();
  const { requests, error } = useOmniAgentRequestsState(api);
  if (!requests.length && !error) return null;
  return (
    <section data-testid="review-agent-requests">
      <SectionHeading count={requests.length} title={t("agents.requestedTitle")} />
      <ItemList>
        {error ? <AgentRequestsError t={t} /> : null}
        {requests.map((request) => (
          <AgentRequestRow key={request.requestId} onNavigate={onNavigate} request={request} t={t} />
        ))}
      </ItemList>
    </section>
  );
}
