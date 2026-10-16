import { useMemo, useState, type ReactElement } from "react";

import type { Worktree } from "../../shared/activity-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { Breadcrumbs } from "../components/ui/Breadcrumbs";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { IconWrap } from "../components/ui/IconWrap";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingItem } from "../components/ui/LoadingItem";
import { PageHead } from "../components/ui/PageHead";
import { TreeList, type TreeNode } from "../components/ui/TreeList";
import { tCount, useI18n } from "../i18n";
import type { Route } from "../navigation";
import { ActivityActionCard, type ActivityActionState } from "./ActivityActionCard";
import { formatElapsed, type ElapsedLanguage } from "./format";
import { useActivitySnapshot } from "./useActivitySnapshot";
import { worktreeIsStale } from "./helpers";

function projectGroups(worktrees: readonly Worktree[]): readonly {
  lastActivityDays: number;
  projectId: string;
  projectName: string;
  worktrees: readonly Worktree[];
}[] {
  return [...new Set(worktrees.map((worktree) => worktree.projectId))].map((projectId) => {
    const group = worktrees
      .filter((worktree) => worktree.projectId === projectId)
      .sort((left, right) => Number(right.isMain) - Number(left.isMain) || left.id.localeCompare(right.id));
    return {
      lastActivityDays: Math.min(...group.map((worktree) => worktree.lastActivityDays)),
      projectId,
      projectName: group[0]?.projectName ?? projectId,
      worktrees: group,
    };
  });
}

function projectSummary(
  worktrees: readonly Worktree[],
  language: "en" | "fr",
  t: ReturnType<typeof useI18n>["t"],
): string {
  const stale = worktrees.filter(worktreeIsStale).length;
  const dirty = worktrees.filter((worktree) => worktree.dirty === true).length;
  // Zero counts are not news: only the exceptions are said.
  return [
    tCount("activity.checkouts", worktrees.length, {}, language),
    stale ? tCount("activity.stale", stale, {}, language) : undefined,
    dirty ? tCount("activity.uncommittedCount", dirty, {}, language) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function worktreeItem(
  worktree: Worktree,
  owner: string | undefined,
  t: ReturnType<typeof useI18n>["t"],
  language: ElapsedLanguage,
): TreeNode["item"] {
  const state =
    worktree.dirty === "unknown"
      ? t("activity.stateUnknown")
      : worktree.dirty
        ? t("activity.uncommitted")
        : t("activity.clean");
  return {
    dataTestId: `activity-worktree-${worktree.id}`,
    dim: worktree.isMain,
    leading: <IconWrap name={worktree.kind === "git-worktree" ? "git" : "folder"} size="sm" />,
    name: worktree.isMain ? t("activity.mainCheckout") : (worktree.branch ?? worktree.id),
    side: t("activity.lastActivityAgo", {
      elapsed: formatElapsed(worktree.lastActivityDays * 86_400, language),
    }),
    sub: [
      worktree.kind === "git-worktree" ? t("activity.gitWorktree") : t("activity.folder"),
      t("activity.ageAgo", { elapsed: formatElapsed(worktree.ageDays * 86_400, language) }),
      state,
      owner,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function WorktreesView({
  api = null,
  onNavigateToRoute = () => undefined,
  projectId,
}: Readonly<{
  api?: DesktopApi | null;
  onNavigateToRoute?: (route: Route) => void;
  projectId?: string;
}>): ReactElement {
  const { language, t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<ActivityActionState | null>(null);
  const { loaded, refresh, snapshot } = useActivitySnapshot(api, action !== null);
  const groups = useMemo(() => projectGroups(snapshot.worktrees), [snapshot.worktrees]);
  const group = projectId ? groups.find((candidate) => candidate.projectId === projectId) : undefined;
  const selected = group?.worktrees.find((worktree) => worktree.id === selectedId);

  const previewRemove = async (): Promise<void> => {
    if (!selected || !api?.previewActivity) return;
    const response = await api.previewActivity({
      kind: "remove-worktree",
      projectId: selected.projectId,
      worktreeId: selected.id,
    });
    setAction({ response, kind: "remove-worktree" });
  };

  if (!projectId) {
    return (
      <div className="shell-page destination-page activity-page">
        <Breadcrumbs
          items={[
            {
              label: t("activity.heading"),
              onClick: () => onNavigateToRoute({ screen: "activity" }),
            },
            { label: t("activity.worktreesHeading") },
          ]}
        />
        <PageHead
          actions={
            <Button
              dataTestId="activity-worktree-cleanup"
              onClick={() =>
                onNavigateToRoute({ screen: "worktree-cleanup", returnTo: { screen: "activity-worktrees" } })
              }
              size="small"
              tone="ghost"
            >
              {t("activity.automaticCleanup")}
            </Button>
          }
          title={t("activity.worktreesHeading")}
        />
        <ItemList>
          {!loaded ? (
            <LoadingItem label={t("activity.loading")} />
          ) : groups.length ? (
            groups.map((candidate) => (
              <ListItem
                dataTestId={`activity-project-${candidate.projectId}`}
                key={candidate.projectId}
                leading={<IconWrap name="folder" size="sm" />}
                name={candidate.projectName}
                onClick={() =>
                  onNavigateToRoute({
                    screen: "activity-worktrees",
                    projectId: candidate.projectId,
                  })
                }
                side={t("activity.lastActivityAgo", {
                  elapsed: formatElapsed(candidate.lastActivityDays * 86_400, language),
                })}
                sub={projectSummary(candidate.worktrees, language, t)}
              />
            ))
          ) : (
            <ListItem dim name={t("activity.worktreesEmpty")} />
          )}
        </ItemList>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="shell-page destination-page activity-page">
        <ItemList>
          <LoadingItem label={t("activity.loading")} />
        </ItemList>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="shell-page destination-page activity-page">
        <ListItem dim name={t("activity.projectUnavailable")} />
      </div>
    );
  }

  const main = group.worktrees.find((worktree) => worktree.isMain);
  const nested = group.worktrees.filter((worktree) => !worktree.isMain);
  const ownerName = (worktree: Worktree): string | undefined =>
    snapshot.sessions.find((session) => session.id === worktree.sessionId)?.name;
  const nestedNodes = nested.map((worktree) => ({
    id: worktree.id,
    item: worktreeItem(worktree, ownerName(worktree), t, language),
  }));
  const nodes: readonly TreeNode[] = main
    ? [{ id: main.id, item: worktreeItem(main, undefined, t, language), children: nestedNodes }]
    : nestedNodes;

  return (
    <div className="shell-page destination-page activity-page">
      <Breadcrumbs
        items={[
          {
            label: t("activity.heading"),
            onClick: () => onNavigateToRoute({ screen: "activity" }),
          },
          {
            label: t("activity.worktreesHeading"),
            onClick: () => onNavigateToRoute({ screen: "activity-worktrees" }),
          },
          { label: group.projectName },
        ]}
      />
      <PageHead
        actions={
          <Button
            dataTestId="activity-remove-worktree"
            disabled={!selected || Boolean(action)}
            onClick={() => void previewRemove()}
            size="small"
            tone="ghost"
          >
            {t("activity.remove")}
          </Button>
        }
        title={group.projectName}
      />
      <Card>
        <CardHeader title={t("activity.checkoutsHeading")} />
        <TreeList defaultExpandedDepth={1} nodes={nodes} onSelect={setSelectedId} selectedId={selectedId} />
        {action && api?.applyActivity ? (
          <ActivityActionCard
            action={action}
            api={{ applyActivity: api.applyActivity }}
            onCancel={() => setAction(null)}
            onDone={() => void refresh()}
          />
        ) : null}
      </Card>
    </div>
  );
}
