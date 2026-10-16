import { useState, type ReactElement } from "react";

import type { DesktopApi } from "../../shared/ipc";
import { Callout } from "../components/ui/Callout";
import { EmptyState } from "../components/ui/EmptyState";
import { IconButton } from "../components/ui/IconButton";
import { Menu } from "../components/ui/Menu";
import { PageHead } from "../components/ui/PageHead";
import { tCount, useI18n } from "../i18n";
import type { Route } from "../navigation";
import { useFeatures } from "../features";
import { ActivityTile } from "./ActivityTile";
import { useActivitySnapshot } from "./useActivitySnapshot";
import { worktreeIsStale } from "./helpers";

type AgentActivityOverviewProps = Readonly<{
  api?: DesktopApi | null;
  onNavigateToRoute?: (route: Route) => void;
}>;

export function AgentActivityOverview({
  api = null,
  onNavigateToRoute = () => undefined,
}: AgentActivityOverviewProps): ReactElement {
  const { language, t } = useI18n();
  const { features } = useFeatures();
  const { failure, loaded, refresh, snapshot } = useActivitySnapshot(api, false);
  const [menuOpen, setMenuOpen] = useState(false);
  const devSimulation =
    Boolean(api?.simulateActivity) && Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  const runawayCount = snapshot.sessions.filter((session) => session.flags.includes("runaway")).length;
  const projectCount = new Set(snapshot.worktrees.map((worktree) => worktree.projectId)).size;
  const staleCount = snapshot.worktrees.filter(worktreeIsStale).length;

  const simulate = async (
    request: { kind: "runaway-process" } | { kind: "stale-worktree"; projectId: string },
  ): Promise<void> => {
    if (!api?.simulateActivity) return;
    await api.simulateActivity(request);
    setMenuOpen(false);
    await refresh();
  };

  return (
    <div className="shell-page destination-page activity-page">
      <PageHead
        actions={
          <div className="activity-head-actions">
            <IconButton icon="refresh" label={t("inventory.refresh")} onClick={() => void refresh()} />
            {devSimulation ? (
              <span className="activity-menu-wrap">
                <button
                  aria-expanded={menuOpen}
                  aria-label={t("activity.simulateMenu")}
                  className="ui-icon-button"
                  onClick={() => setMenuOpen((open) => !open)}
                  type="button"
                >
                  …
                </button>
                {menuOpen ? (
                  <Menu
                    items={[
                      // A runaway process is a process action: there is nothing to simulate on a
                      // platform without process observation.
                      ...(snapshot.platformSupported
                        ? [
                            {
                              label: t("activity.simulateRunaway"),
                              onSelect: () => void simulate({ kind: "runaway-process" }),
                            },
                          ]
                        : []),
                      {
                        label: t("activity.simulateStale"),
                        onSelect: () =>
                          void simulate({
                            kind: "stale-worktree",
                            projectId: snapshot.worktrees[0]?.projectId ?? "demo",
                          }),
                      },
                    ]}
                    onClose={() => setMenuOpen(false)}
                  />
                ) : null}
              </span>
            ) : null}
          </div>
        }
        description={snapshot.platformSupported ? t("activity.description") : t("activity.platformUnsupported")}
        title={t("activity.heading")}
      />
      {failure ? (
        <div data-testid="activity-unavailable">
          <Callout title={t("activity.unavailableTitle")} tone="error">
            {t(loaded ? "activity.unavailableStale" : "activity.unavailable")} {failure}
          </Callout>
        </div>
      ) : null}
      {features.activityAgents && loaded && snapshot.sessions.length === 0 ? (
        <EmptyState
          description={t("activity.noSessionsDescription")}
          illustration="agent"
          title={t("activity.noSessionsTitle")}
        />
      ) : null}
      <div className="activity-tile-grid">
        {features.activityAgents ? (
          <ActivityTile
            badge={runawayCount > 0 ? tCount("activity.runaway", runawayCount, {}, language) : undefined}
            dataTestId="activity-tile-agents"
            icon="agent"
            meta={
              loaded
                ? `${tCount("activity.sessions", snapshot.sessions.length, {}, language)} · ${tCount(
                    "activity.processes",
                    snapshot.processes.length,
                    {},
                    language,
                  )}`
                : t(failure ? "activity.unavailableShort" : "activity.loading")
            }
            name={t("activity.agentsHeading")}
            onClick={() => onNavigateToRoute({ screen: "activity-agents" })}
          />
        ) : null}
        <ActivityTile
          badge={staleCount > 0 ? tCount("activity.stale", staleCount, {}, language) : undefined}
          badgeTone="warn"
          dataTestId="activity-tile-worktrees"
          icon="git"
          meta={
            loaded
              ? `${tCount("activity.projects", projectCount, {}, language)} · ${tCount(
                  "activity.checkouts",
                  snapshot.worktrees.length,
                  {},
                  language,
                )}`
              : t(failure ? "activity.unavailableShort" : "activity.loading")
          }
          name={t("activity.worktreesHeading")}
          onClick={() => onNavigateToRoute({ screen: "activity-worktrees" })}
        />
      </div>
    </div>
  );
}
