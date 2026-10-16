import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";

import type { AgentProcess, AgentSession, ActivitySnapshot, Worktree } from "../../shared/activity-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { Breadcrumbs } from "../components/ui/Breadcrumbs";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { IconWrap } from "../components/ui/IconWrap";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingItem } from "../components/ui/LoadingItem";
import { Menu } from "../components/ui/Menu";
import { PageHead } from "../components/ui/PageHead";
import { TreeList, type TreeNode } from "../components/ui/TreeList";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { ActivityActionCard, type ActivityActionState } from "./ActivityActionCard";
import { formatElapsed, formatSince, formatSize, type ElapsedLanguage } from "./format";
import {
  activityEntries,
  entryProcesses,
  flagBadges,
  processesForSession,
  processSide,
  worktreeForSessionId,
} from "./helpers";
import { processDetailsNode } from "./ProcessDetails";
import { subtreeTotals } from "./process-totals";
import { useActivitySnapshot } from "./useActivitySnapshot";

type TaskRow = Readonly<{ key: string; name: string; sub: ReactNode }>;

function ExpandableText({ text, t }: Readonly<{ text: string; t: ReturnType<typeof useI18n>["t"] }>): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <span>
      <span
        style={
          expanded
            ? undefined
            : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3, overflow: "hidden" }
        }
      >
        {text}
      </span>{" "}
      <button
        aria-expanded={expanded}
        className="activity-inline-link"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {expanded ? t("activity.taskShowLess") : t("activity.taskShowMore")}
      </button>
    </span>
  );
}

function taskRows(
  session: AgentSession,
  t: ReturnType<typeof useI18n>["t"],
  language: ElapsedLanguage,
): readonly TaskRow[] {
  const activity = session.activity;
  if (!activity) return [];
  const rows: TaskRow[] = [];
  if (activity.firstPrompt) {
    rows.push({
      key: "first",
      name: t("activity.taskAskedFirst"),
      sub: <ExpandableText t={t} text={activity.firstPrompt} />,
    });
  }
  if (activity.latestPrompt) {
    const ago = formatSince(activity.latestPromptAt, language);
    rows.push({
      key: "latest",
      name: t("activity.taskWorkingOnNow"),
      sub: ago ? `${activity.latestPrompt} · ${t("activity.taskAgo", { elapsed: ago })}` : activity.latestPrompt,
    });
  }
  if (activity.lastTool) {
    rows.push({
      key: "tool",
      name: t("activity.taskLastTool"),
      sub: activity.lastTool.target
        ? `${activity.lastTool.name} · ${activity.lastTool.target}`
        : activity.lastTool.name,
    });
  }
  if (activity.turns !== undefined) {
    rows.push({
      key: "turns",
      name: t("activity.taskTurns"),
      sub: activity.tailTruncated ? t("activity.taskTurnsAtLeast", { count: activity.turns }) : String(activity.turns),
    });
  }
  if (activity.lastAnswerAt !== undefined) {
    const ago = formatSince(activity.lastAnswerAt, language);
    if (ago)
      rows.push({ key: "answer", name: t("activity.taskLastAnswer"), sub: t("activity.taskAgo", { elapsed: ago }) });
  }
  if (activity.subagents) {
    rows.push({ key: "subagents", name: t("activity.taskSubAgents"), sub: String(activity.subagents) });
  }
  return rows;
}

/**
 * The same Task-card evidence as `taskRows`, but as plain bounded strings — Summarize's
 * deterministic input (Brief 35a). Never the raw transcript, only what is already shown above.
 */
function summarizeEvidenceLines(session: AgentSession): readonly string[] {
  const activity = session.activity;
  if (!activity) return [];
  return [
    activity.firstPrompt && `Asked first: ${activity.firstPrompt}`,
    activity.latestPrompt && `Working on now: ${activity.latestPrompt}`,
    activity.lastTool &&
      `Last tool: ${activity.lastTool.name}${activity.lastTool.target ? ` ${activity.lastTool.target}` : ""}`,
    activity.turns !== undefined && `Turns: ${activity.turns}`,
    activity.subagents && `Sub-agents: ${activity.subagents}`,
  ].filter((line): line is string => Boolean(line));
}

function processSub(process: AgentProcess): ReactNode {
  return (
    <span
      style={{
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: 2,
        fontFamily: "var(--font-mono)",
        overflow: "hidden",
        overflowWrap: "anywhere",
        minWidth: 0,
      }}
    >
      {process.fullCommand ?? process.command}
    </span>
  );
}

function processNode(
  process: AgentProcess,
  totals: Readonly<{ cpuPercent: number; rssMb: number }> | undefined,
  t: ReturnType<typeof useI18n>["t"],
  language: ElapsedLanguage,
): TreeNode {
  const own = processSide(process, language);
  const side =
    process.depth === 0 && totals
      ? t("activity.ownSubtree", {
          own,
          subtreeCpu: totals.cpuPercent.toFixed(1),
          subtreeMemory: formatSize(totals.rssMb),
        })
      : own;
  return {
    id: String(process.pid),
    item: {
      badges: flagBadges(process.flags, t),
      dataTestId: `activity-process-${process.pid}`,
      leading: <IconWrap name="agent" size="sm" />,
      name: process.name,
      side,
      sub: processSub(process),
    },
  };
}

function processTree(
  processes: readonly AgentProcess[],
  rootPid: number,
  api: DesktopApi | null,
  t: ReturnType<typeof useI18n>["t"],
  language: ElapsedLanguage,
): readonly TreeNode[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const childrenByParent = new Map<number, AgentProcess[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process);
    childrenByParent.set(process.ppid, children);
  }
  const build = (process: AgentProcess, seen: Set<number>): TreeNode => {
    const nextSeen = new Set(seen).add(process.pid);
    const children = (childrenByParent.get(process.pid) ?? [])
      .filter((child) => !nextSeen.has(child.pid))
      .sort((left, right) => right.cpuPercent - left.cpuPercent || right.rssMb - left.rssMb || left.pid - right.pid)
      .map((child) => build(child, nextSeen));
    const totals = process.depth === 0 ? subtreeTotals(processes, process.pid) : undefined;
    const node = processNode(process, totals, t, language);
    return { ...node, children: [processDetailsNode(process, api, language, t), ...children] };
  };
  const root = byPid.get(rootPid) ?? processes.find((process) => process.depth === 0);
  if (root) return [build(root, new Set())];
  return processes.filter((process) => !byPid.has(process.ppid)).map((process) => build(process, new Set()));
}

function evidenceLabel(session: AgentSession, t: ReturnType<typeof useI18n>["t"]): string {
  if (session.link === "session-file") return t("activity.linkedBySessionFile");
  if (session.link === "rollout-match") return t("activity.matchedToRollout");
  return t("activity.processOnly");
}

function sessionSubline(
  session: AgentSession,
  onOpenProject: () => void,
  t: ReturnType<typeof useI18n>["t"],
  evidence: string,
): ReactNode {
  const location =
    session.projectId && session.projectName ? (
      <button className="activity-inline-link" onClick={onOpenProject} type="button">
        {session.projectName}
      </button>
    ) : (
      session.cwd || undefined
    );
  return (
    <span className="activity-session-subline">
      {[
        t(`activity.harness.${session.harness}`),
        t(`activity.entrypoint.${session.entrypoint}`),
        location,
        session.branch,
        evidence,
        session.title ? session.name : undefined,
      ]
        .filter(Boolean)
        .map((part, index) => (
          <span key={index}>
            {index ? <span className="activity-session-subline__separator">·</span> : null}
            {part}
          </span>
        ))}
    </span>
  );
}

function worktreeSubline(
  worktree: Worktree,
  session: AgentSession | undefined,
  t: ReturnType<typeof useI18n>["t"],
  language: ElapsedLanguage,
): string {
  const kind = worktree.kind === "git-worktree" ? t("activity.gitWorktree") : t("activity.folder");
  const state =
    worktree.dirty === "unknown"
      ? t("activity.stateUnknown")
      : worktree.dirty
        ? t("activity.uncommitted")
        : t("activity.clean");
  const age = t("activity.ageAgo", { elapsed: formatElapsed(worktree.ageDays * 86_400, language) });
  return [kind, age, state, session?.name].filter(Boolean).join(" · ");
}

export function AgentSessionView({
  api = null,
  onNavigateToRoute = () => undefined,
  sessionId,
}: Readonly<{
  api?: DesktopApi | null;
  onNavigateToRoute?: (route: Route) => void;
  sessionId: string;
}>): ReactElement {
  const { language, t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<ActivityActionState | null>(null);
  const [lastSession, setLastSession] = useState<AgentSession | undefined>();
  const { loaded, refresh, snapshot } = useActivitySnapshot(api, action !== null);
  const liveEntry = activityEntries(snapshot).find((entry) => entry.session.id === sessionId);
  const liveSession = liveEntry?.session;
  const session = liveSession ?? lastSession;
  const ended = Boolean(session && !liveSession);

  useEffect(() => {
    if (liveSession) setLastSession(liveSession);
  }, [liveSession]);

  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const processes = session
    ? liveEntry
      ? entryProcesses(snapshot, liveEntry)
      : processesForSession(snapshot, session)
    : [];
  const processMap = useMemo(() => new Map(processes.map((process) => [String(process.pid), process])), [processes]);
  const tree = useMemo(
    () => (session ? processTree(processes, session.pid, api, t, language) : []),
    [api, language, processes, session, t],
  );
  const selectedProcess =
    (selectedId ? processMap.get(selectedId) : undefined) ??
    (session ? processMap.get(String(session.pid)) : undefined);
  const ownedWorktrees = session ? worktreeForSessionId(snapshot.worktrees, session.id) : [];
  const sessionTaskRows = useMemo(() => (session ? taskRows(session, t, language) : []), [language, session, t]);
  const evidenceLines = useMemo(() => (session ? summarizeEvidenceLines(session) : []), [session]);
  const [doingSentence, setDoingSentence] = useState<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setDoingSentence(undefined);
    if (!api?.runInferenceCommand || evidenceLines.length === 0) return;
    void api
      .runInferenceCommand({ command: "summarize", kind: "session", lines: evidenceLines })
      .then((response) => active && response.command === "summarize" && setDoingSentence(response.sentence))
      .catch(() => undefined);
    return () => void (active = false);
  }, [api, evidenceLines]);
  const resumeAvailable = selectedProcess?.state === "stopped";

  const previewStop = async (): Promise<void> => {
    if (!selectedProcess || !api?.previewActivity) return;
    setActionsMenuOpen(false);
    const response = await api.previewActivity({ kind: "stop-process", pid: selectedProcess.pid });
    setAction({ response, kind: "stop" });
  };
  const previewSignal = async (signalAction: "kill" | "pause" | "resume"): Promise<void> => {
    if (!selectedProcess || !api?.previewActivity) return;
    setActionsMenuOpen(false);
    const response = await api.previewActivity({
      kind: "signal-process",
      pid: selectedProcess.pid,
      action: signalAction,
    });
    setAction({ response, kind: signalAction });
  };
  const previewRenice = async (nice: 10 | 0): Promise<void> => {
    if (!selectedProcess || !api?.previewActivity) return;
    setActionsMenuOpen(false);
    const response = await api.previewActivity({ kind: "renice-process", pid: selectedProcess.pid, nice });
    setAction({ response, kind: "renice" });
  };
  const openTerminal = async (): Promise<void> => {
    if (!selectedProcess || !api?.openTerminal) return;
    setActionsMenuOpen(false);
    const cwd = selectedProcess.cwd ?? session?.cwd;
    if (!cwd) return;
    await api.openTerminal({ cwd });
    await refresh();
  };
  const stopJob = async (): Promise<void> => {
    if (!session?.job || !api?.stopAgentJob) return;
    setActionsMenuOpen(false);
    await api.stopAgentJob({ jobId: session.job.jobId });
    await refresh();
  };

  if (!session) {
    return (
      <div className="shell-page destination-page activity-page">
        <ListItem dim name={t("activity.sessionUnavailable")} />
      </div>
    );
  }

  return (
    <div className="shell-page destination-page activity-page">
      <Breadcrumbs
        items={[
          {
            label: t("activity.heading"),
            onClick: () => onNavigateToRoute({ screen: "activity" }),
          },
          {
            label: t("activity.agentsHeading"),
            onClick: () => onNavigateToRoute({ screen: "activity-agents" }),
          },
          { label: session.title ?? session.name },
        ]}
      />
      <PageHead
        actions={
          <div className="activity-head-actions">
            {session.projectId ? (
              <Button
                disabled={ended}
                onClick={() =>
                  onNavigateToRoute({
                    screen: "project",
                    projectId: session.projectId ?? "",
                    tab: "overview",
                  })
                }
                size="small"
                tone="ghost"
              >
                {t("activity.openProject")}
              </Button>
            ) : null}
            {snapshot.platformSupported ? (
              <span className="activity-menu-wrap">
                <Button
                  ariaExpanded={actionsMenuOpen}
                  dataTestId={`activity-actions-${session.id}`}
                  disabled={
                    session.job
                      ? session.job.status !== "running" || ended
                      : !selectedProcess || ended || Boolean(action)
                  }
                  onClick={() => setActionsMenuOpen((open) => !open)}
                  size="small"
                  tone="ghost"
                >
                  {t("activity.actionsMenu")}
                </Button>
                {actionsMenuOpen ? (
                  <Menu
                    items={
                      session.job
                        ? [{ label: t("activity.stop"), onSelect: () => void stopJob() }]
                        : [
                            { label: t("activity.stop"), onSelect: () => void previewStop() },
                            { label: t("activity.kill"), onSelect: () => void previewSignal("kill") },
                            resumeAvailable
                              ? { label: t("activity.resume"), onSelect: () => void previewSignal("resume") }
                              : { label: t("activity.pause"), onSelect: () => void previewSignal("pause") },
                            { label: t("activity.openInTerminal"), onSelect: () => void openTerminal() },
                            { label: t("activity.increasePriority"), onSelect: () => void previewRenice(10) },
                            { label: t("activity.resetPriority"), onSelect: () => void previewRenice(0) },
                          ]
                    }
                    onClose={() => setActionsMenuOpen(false)}
                  />
                ) : null}
              </span>
            ) : null}
          </div>
        }
        description={sessionSubline(
          session,
          () => {
            if (session.projectId)
              onNavigateToRoute({
                screen: "project",
                projectId: session.projectId,
                tab: "overview",
              });
          },
          t,
          ended ? t("activity.sessionEnded") : evidenceLabel(session, t),
        )}
        title={session.title ?? session.name}
      />
      {ended ? <ListItem dim name={t("activity.sessionEnded")} /> : null}
      {sessionTaskRows.length ? (
        <Card>
          <CardHeader title={t("activity.taskHeading")} />
          <ItemList variant="nested">
            {doingSentence ? (
              <ListItem dataTestId="activity-task-doing" name={t("activity.taskDoing", { sentence: doingSentence })} />
            ) : null}
            {sessionTaskRows.map((row) => (
              <ListItem key={row.key} name={row.name} sub={row.sub} />
            ))}
          </ItemList>
        </Card>
      ) : null}
      <Card>
        <CardHeader hint={t("activity.percentOfOneCore")} title={t("activity.processesHeading")} />
        {loaded ? (
          <TreeList defaultExpandedDepth={2} nodes={tree} onSelect={setSelectedId} selectedId={selectedId} />
        ) : (
          <ItemList variant="nested">
            <LoadingItem label={t("activity.loading")} />
          </ItemList>
        )}
        {action && api?.applyActivity ? (
          <ActivityActionCard
            action={action}
            api={{ applyActivity: api.applyActivity }}
            onCancel={() => setAction(null)}
            onDone={() => void refresh()}
          />
        ) : null}
      </Card>
      {ownedWorktrees.length ? (
        <Card>
          <CardHeader title={t("activity.worktreesHeading")} />
          <ItemList>
            {ownedWorktrees.map((worktree) => (
              <ListItem
                dataTestId={`activity-session-worktree-${worktree.id}`}
                key={worktree.id}
                leading={<IconWrap name={worktree.kind === "git-worktree" ? "git" : "folder"} size="sm" />}
                name={`${worktree.projectName} › ${worktree.id}`}
                sub={worktreeSubline(
                  worktree,
                  snapshot.sessions.find((item) => item.id === worktree.sessionId),
                  t,
                  language,
                )}
              />
            ))}
          </ItemList>
        </Card>
      ) : null}
    </div>
  );
}
