import type { ReactElement } from "react";

import type { AssignmentActionState } from "../../domain/assignment-plan";
import type { EntryRef, RegistryView } from "../../domain/project-source-registry";
import type { DesktopApi } from "../../shared/ipc";
import type { AgentRequest } from "../../shared/agents-ipc";
import type { AuditFinding } from "../audit/audit-report";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingSkeleton } from "../components/ui/Skeleton";
import { SectionHeading } from "../components/ui/SectionHeading";
import { tCount, useI18n } from "../i18n";
import { entryForRef, type DestinationAuditState } from "../destination-state";
import type { Route } from "../navigation";
import type { BindingPreviewGroup } from "./binding-previews";
import { AgentRequestRow, AgentRequestsError } from "./agent-requests";
import { FindingExplanation } from "./FindingExplanation";
import type { ExplainFindingApi } from "./explain-finding";

const SEVERITY_ORDER = ["error", "warning", "info"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];
export type ReviewFindingGroup = Readonly<{ entry: EntryRef; label: string; findings: readonly AuditFinding[] }>;

export function groupReviewFindings(
  report: DestinationAuditState["report"],
  registry: RegistryView,
): Readonly<Record<Severity, readonly ReviewFindingGroup[]>> {
  const groups = new Map<Severity, Map<string, { entry: EntryRef; label: string; findings: AuditFinding[] }>>();
  for (const severity of SEVERITY_ORDER) groups.set(severity, new Map());
  for (const finding of report?.findings ?? []) {
    const entry = entryForRef(registry, finding.entry);
    const label = entry?.displayName || entry?.displayRoot || finding.entry.id;
    const severityGroups = groups.get(finding.severity);
    if (!severityGroups) continue;
    const key = `${finding.entry.kind}:${finding.entry.id}`;
    const group = severityGroups.get(key) ?? { entry: finding.entry, label, findings: [] };
    group.findings.push(finding);
    severityGroups.set(key, group);
  }
  const result = {} as Record<Severity, readonly ReviewFindingGroup[]>;
  for (const severity of SEVERITY_ORDER)
    result[severity] = [...(groups.get(severity)?.values() ?? [])]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((group) => ({
        ...group,
        findings: [...group.findings].sort((left, right) => left.message.localeCompare(right.message)),
      }));
  return result;
}

function severityTone(severity: Severity): BadgeTone {
  return severity === "error" ? "bad" : severity === "warning" ? "warn" : "neutral";
}

function FindingRow({
  entry,
  finding,
  label,
  onNavigateToEntry,
  onNavigateToRoute,
  api,
  t,
}: Readonly<{
  api?: ExplainFindingApi | null;
  entry: EntryRef;
  finding: AuditFinding;
  label: string;
  onNavigateToEntry: (ref: EntryRef) => void;
  onNavigateToRoute?: (route: Route) => void;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const navigate = (): void => onNavigateToEntry(entry);
  return (
    <div
      className="ui-item ui-item--clickable"
      onClick={navigate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span className="ui-item__leading">
        <Badge tone={severityTone(finding.severity)} variant="type">
          {t(`review.kind.${finding.kind}` as Parameters<typeof t>[0])}
        </Badge>
      </span>
      <span className="ui-item__copy">
        <span className="ui-item__name">{finding.message}</span>
        <span className="ui-item__sub">
          {finding.examples?.length
            ? finding.examples.join(", ")
            : `${label} · ${t(`review.entryKinds.${entry.kind}` as Parameters<typeof t>[0])}`}
          <FindingExplanation api={api} finding={finding} onNavigateToRoute={onNavigateToRoute} />
        </span>
      </span>
      <span aria-hidden="true" className="ui-item__chevron">
        ›
      </span>
    </div>
  );
}

function changedCount(states: Readonly<Record<AssignmentActionState, number>>): number {
  return states.add + states.update + states.conflict + states.blocked;
}

function pendingRows(
  bindingPreviews: readonly BindingPreviewGroup[],
  registry: RegistryView,
  language: "en" | "fr",
  t: ReturnType<typeof useI18n>["t"],
): readonly Readonly<{ projectId: string; name: string; sub: string; blocked: boolean; conflicts: number }>[] {
  const byProject = new Map<string, { states: Record<AssignmentActionState, number>; marketplaces: Set<string> }>();
  for (const group of bindingPreviews)
    for (const plan of group.plans) {
      const pending = plan.actions.filter((action) => action.state !== "current" && action.state !== "linked");
      if (!pending.length) continue;
      const project = byProject.get(plan.projectId) ?? {
        states: { add: 0, current: 0, update: 0, linked: 0, conflict: 0, blocked: 0 },
        marketplaces: new Set<string>(),
      };
      for (const action of pending) project.states[action.state] += 1;
      const source = registry.sources.find((candidate) => candidate.ref.id === group.sourceId);
      project.marketplaces.add(source?.displayName || source?.displayRoot || group.sourceId);
      byProject.set(plan.projectId, project);
    }
  return [...byProject.entries()]
    .map(([projectId, { marketplaces, states }]) => {
      const project = registry.projects.find((candidate) => candidate.ref.id === projectId);
      if (!project) return null;
      const counts = [
        states.add ? tCount("review.pending.additions", states.add, {}, language) : "",
        states.update ? tCount("review.pending.updates", states.update, {}, language) : "",
        states.conflict ? tCount("review.pending.conflicts", states.conflict, {}, language) : "",
      ].filter(Boolean);
      const count = changedCount(states);
      if (count && marketplaces.size) {
        const marketplace = [...marketplaces].join(", ");
        if (states.add === count && counts.length === 1)
          counts[0] = tCount("review.pending.additionsFromMarketplace", count, { marketplace }, language);
        else counts.push(t("review.pending.fromMarketplace", { count, marketplace }));
      }
      return {
        projectId,
        name: project.displayName || project.displayRoot,
        sub: counts.join(" · "),
        blocked: states.blocked > 0,
        conflicts: states.conflict,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function PendingApproval({
  bindingPreviews,
  onNavigateToRoute,
  registry,
  requests,
  requestsError,
  requestsLoading,
  t,
}: Readonly<{
  bindingPreviews: readonly BindingPreviewGroup[];
  onNavigateToRoute?: (route: Route) => void;
  registry: RegistryView;
  requests: readonly AgentRequest[];
  requestsError: boolean;
  requestsLoading: boolean;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const { language } = useI18n();
  const rows = pendingRows(bindingPreviews, registry, language, t);
  return (
    <section data-testid="review-pending">
      <SectionHeading count={rows.length + requests.length} title={t("review.pending.title")} />
      <ItemList>
        {rows.map((row) => (
          <ListItem
            dataTestId={`review-pending-${row.projectId}`}
            key={row.projectId}
            name={row.name}
            sub={row.sub}
            side={
              row.blocked || row.conflicts ? (
                <Badge tone={row.blocked ? "neutral" : "bad"} variant="status">
                  {t(row.blocked ? "review.pending.blocked" : "review.pending.conflict")}
                </Badge>
              ) : undefined
            }
            onClick={() => onNavigateToRoute?.({ screen: "operation-apply", projectId: row.projectId })}
          />
        ))}
        {requests.map((request) => (
          <AgentRequestRow key={request.requestId} onNavigate={onNavigateToRoute} request={request} t={t} />
        ))}
        {requestsError ? (
          <AgentRequestsError t={t} />
        ) : requestsLoading ? (
          <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("canvas.review") })} />
        ) : null}
        {!rows.length && !requests.length && !requestsError && !requestsLoading ? (
          <ListItem dim name={t("review.pending.empty")} />
        ) : null}
      </ItemList>
    </section>
  );
}

export function Findings({
  api,
  audit,
  groups,
  onNavigateToEntry,
  onNavigateToRoute,
  t,
}: Readonly<{
  api?: ExplainFindingApi | null;
  audit: DestinationAuditState;
  groups: Readonly<Record<Severity, readonly ReviewFindingGroup[]>>;
  onNavigateToEntry: (ref: EntryRef) => void;
  onNavigateToRoute?: (route: Route) => void;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const findings = SEVERITY_ORDER.flatMap((severity) =>
    groups[severity].flatMap((group) =>
      group.findings.map((finding) => ({ entry: group.entry, finding, label: group.label })),
    ),
  );
  return (
    <section data-testid="review-findings-list">
      <SectionHeading count={findings.length} title={t("review.findingsTitle")} />
      <ItemList>
        {audit.status === "running" && !findings.length ? (
          <LoadingSkeleton label={t("review.session.running")} />
        ) : findings.length ? (
          findings.map(({ entry, finding, label }, index) => (
            <FindingRow
              api={api}
              key={`${entry.kind}:${entry.id}:${finding.kind}:${finding.message}:${index}`}
              entry={entry}
              finding={finding}
              label={label}
              onNavigateToEntry={onNavigateToEntry}
              onNavigateToRoute={onNavigateToRoute}
              t={t}
            />
          ))
        ) : (
          <EmptyState
            description={t("review.noFindingsContextDescription")}
            illustration="skill"
            title={audit.report ? t("review.noFindings") : t("review.noAudit")}
          />
        )}
      </ItemList>
    </section>
  );
}
