import { useEffect, useState, type ReactElement } from "react";

import type { AgentRequest } from "../../shared/agents-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { useI18n } from "../i18n";
import { useReviewRevision } from "../review/use-review-revision";
import { agentApprovalReason, agentRequesterLabel, agentRelativeTime } from "../review/agent-requests";

type AgentBannerApi = Partial<Pick<DesktopApi, "listAgentRequests" | "declineAgentRequest" | "onReviewChanged">> | null;
export function AgentRequestBanner({
  api,
  requestId,
  applying = false,
}: Readonly<{ api: AgentBannerApi; requestId?: string; applying?: boolean }>): ReactElement | null {
  const { t } = useI18n();
  const revision = useReviewRevision(api);
  const [request, setRequest] = useState<AgentRequest | null>(null);
  useEffect(() => {
    let active = true;
    if (!requestId || !api?.listAgentRequests)
      return () => {
        active = false;
      };
    void api
      .listAgentRequests()
      .then((result) => {
        if (active) setRequest(result.requests.find((item) => item.requestId === requestId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, requestId, revision]);
  if (!request) return null;
  const requester = agentRequesterLabel(request, t);
  const time = agentRelativeTime(request.createdAt, t);
  const decline = (): void => {
    if (applying || !api?.declineAgentRequest) return;
    void api.declineAgentRequest({ requestId: request.requestId }).then(() => setRequest(null));
  };
  return (
    <div data-testid="agent-request-banner">
      <Card className="agent-request-banner">
        <CardHeader
          actions={
            <Button dataTestId="agent-request-decline" disabled={applying} onClick={decline} size="small" tone="ghost">
              {t("agents.decline")}
            </Button>
          }
          title={t("agents.requestedBy", { requester, time })}
        />
        {request.approvalReason ? (
          <p className="ui-item__sub">{agentApprovalReason(request.approvalReason, t)}</p>
        ) : null}
      </Card>
    </div>
  );
}
