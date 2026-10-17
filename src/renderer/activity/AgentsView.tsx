import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { AgentStatus } from "../../shared/agents-ipc";
import { formatAgentJobContext } from "../../shared/agent-jobs-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { IconWrap } from "../components/ui/IconWrap";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingBoundary, LoadingSkeleton } from "../components/ui/Skeleton";
import { Breadcrumbs } from "../components/ui/Breadcrumbs";
import { PageHead } from "../components/ui/PageHead";
import { SearchField } from "../components/ui/SearchField";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { tCount, useI18n } from "../i18n";
import type { Route } from "../navigation";
import { formatSize } from "./format";
import {
  activityEntries,
  entryFlags,
  entryProcesses,
  entrySearchText,
  flagBadges,
  sessionRowName,
  sessionRowSub,
} from "./helpers";
import { subtreeTotals, type ProcessTotals } from "./process-totals";
import { useActivitySnapshot } from "./useActivitySnapshot";
import { agentName, harnessSummary } from "../agents/agent-utils";
import { Button } from "../components/ui/Button";

type SortMode = "cpu" | "memory" | "started";

export function AgentsView({
  api = null,
  onNavigateToRoute = () => undefined,
}: Readonly<{
  api?: DesktopApi | null;
  onNavigateToRoute?: (route: Route) => void;
}>): ReactElement {
  const { language, t } = useI18n();
  const { loaded, refresh, snapshot } = useActivitySnapshot(api, false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("started");
  useEffect(() => {
    let active = true;
    if (!api?.getAgentStatus)
      return () => {
        active = false;
      };
    void api
      .getAgentStatus()
      .then((value) => {
        if (active) setAgentStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);
  // One helper computes every root's subtree totals (D3), recomputed whenever the snapshot
  // object itself changes (a new object every poll) so the order never goes stale.
  const totalsByPid = useMemo(() => {
    const byPid = new Map<string, ProcessTotals>();
    for (const entry of activityEntries(snapshot))
      byPid.set(entry.session.id, subtreeTotals(entryProcesses(snapshot, entry), entry.session.pid));
    return byPid;
  }, [snapshot]);
  const totalsFor = (sessionId: string): ProcessTotals => totalsByPid.get(sessionId) ?? { cpuPercent: 0, rssMb: 0 };
  const entries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return activityEntries(snapshot)
      .filter((entry) => !normalizedQuery || entrySearchText(snapshot, entry).includes(normalizedQuery))
      .sort((left, right) => {
        const leftGroup = left.hostProcess ? 2 : left.session.link === "process-only" ? 1 : 0;
        const rightGroup = right.hostProcess ? 2 : right.session.link === "process-only" ? 1 : 0;
        if (leftGroup !== rightGroup) return leftGroup - rightGroup;
        const leftProcesses = entryProcesses(snapshot, left);
        const rightProcesses = entryProcesses(snapshot, right);
        const leftTotals = totalsFor(left.session.id);
        const rightTotals = totalsFor(right.session.id);
        const leftValue =
          sort === "cpu" ? leftTotals.cpuPercent : sort === "memory" ? leftTotals.rssMb : left.session.startedAt;
        const rightValue =
          sort === "cpu" ? rightTotals.cpuPercent : sort === "memory" ? rightTotals.rssMb : right.session.startedAt;
        const processTie = rightProcesses.length - leftProcesses.length;
        return sort === "started" ? rightValue - leftValue : rightValue - leftValue || processTie;
      });
  }, [query, snapshot, sort, totalsByPid]);
  const agentDescription = !snapshot.platformSupported
    ? t("activity.platformUnsupported")
    : agentStatus
      ? agentStatus.harnesses
          .map(
            (harness) =>
              `${agentName(harness.harness)}${language === "fr" ? " : " : ": "}${harnessSummary(harness, t, language)}`,
          )
          .join(" — ") || t("agentsSetup.activityNotDetected")
      : undefined;

  return (
    <div className="shell-page destination-page activity-page">
      <Breadcrumbs
        items={[
          {
            label: t("activity.heading"),
            onClick: () => onNavigateToRoute({ screen: "activity" }),
          },
          { label: t("activity.agentsHeading") },
        ]}
      />
      <PageHead
        actions={
          <div className="activity-list-controls">
            <Button onClick={() => onNavigateToRoute({ screen: "settings" })} size="small" tone="ghost">
              {t("agentsSetup.activitySetup")}
            </Button>
            <SearchField
              label={t("activity.searchLabel")}
              onChange={setQuery}
              placeholder={t("activity.searchPlaceholder")}
              value={query}
            />
            <SegmentedControl
              ariaLabel={t("activity.sortLabel")}
              onValueChange={setSort}
              options={[
                { label: t("activity.sortCpu"), value: "cpu" },
                { label: t("activity.sortMemory"), value: "memory" },
                { label: t("activity.sortStarted"), value: "started" },
              ]}
              value={sort}
            />
          </div>
        }
        description={agentDescription}
        title={t("activity.agentsHeading")}
      />
      <LoadingBoundary
        loading={!loaded}
        label={t("canvas.loadingSurface", { surface: t("canvas.activity") })}
        minHeight={216}
      >
        <ItemList>
          {!loaded ? (
            <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("canvas.activity") })} />
          ) : entries.length ? (
            entries.map((entry) => {
              const processes = entryProcesses(snapshot, entry);
              const session = entry.session;
              const totals = totalsFor(session.id);
              const side = session.job
                ? `${formatAgentJobContext(session.job.context)} · ${session.job.tokens.input + session.job.tokens.output} tokens · $${session.job.costUsd.toFixed(2)}`
                : `${totals.cpuPercent.toFixed(1)} % · ${formatSize(totals.rssMb)}`;
              return (
                <div key={session.id}>
                  <ListItem
                    dataTestId={`activity-agent-item-${session.id}`}
                    leading={<IconWrap name="agent" size="sm" />}
                    name={entry.hostProcess ? session.name : sessionRowName(session, t)}
                    badges={flagBadges(entryFlags(snapshot, entry), t)}
                    onClick={() => onNavigateToRoute({ screen: "activity-agent", sessionId: session.id })}
                    side={side}
                    sub={
                      entry.hostProcess
                        ? tCount("activity.processes", processes.length, {}, language)
                        : sessionRowSub(session)
                    }
                  />
                  {session.job?.status === "running" && api?.stopAgentJob ? (
                    <Button
                      dataTestId={`activity-job-stop-${session.job.jobId}`}
                      onClick={() => void api.stopAgentJob!({ jobId: session.job!.jobId }).then(() => refresh())}
                      size="small"
                      tone="ghost"
                    >
                      {t("activity.stop")}
                    </Button>
                  ) : null}
                </div>
              );
            })
          ) : (
            <ListItem dim name={t("activity.agentsEmpty")} />
          )}
        </ItemList>
      </LoadingBoundary>
    </div>
  );
}
