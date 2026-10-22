import { LoadingBoundary, LoadingSkeleton } from "../../components/ui/Skeleton";
import { ExternalReviewChecks } from "../external-library/ReviewChecks";
import { StorefrontReviewChecks } from "../storefronts/StorefrontReviewChecks";
import { useState, type ReactElement } from "react";
import { createResourceCatalogue } from "../../../domain/resource-catalogue";
import { translateCount, useI18n, tCount } from "../../i18n";
import {
  agentApprovalReason,
  agentRequestAction,
  agentRequesterLabel,
  agentRelativeTime,
  agentRequestRoute,
  AgentRequestsError,
} from "../../review/agent-requests";
import { Findings, groupReviewFindings } from "../../review/ReviewSections";
import { CanvasGlyph } from "../CanvasGlyph";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { maintenanceIntent, projectHarnesses, projectSkillIntent, harnessLabel } from "../project-view-model";
import { MissingProjectsSheet } from "../MissingProjectsSheet";
import { useCanvasRail } from "./rail-context";
import { RailPendingBindings } from "./RailPendingBindings";

export function RailReviewSheet(props: Readonly<{ onApplyingChange: (active: boolean) => void }>): ReactElement | null {
  const rail = useCanvasRail();
  const { language, t } = useI18n();
  const [missingOpen, setMissingOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  if (!rail) return null;
  const { canvas, requests, projectSkills } = rail;
  const catalogue = createResourceCatalogue(canvas.snapshot);
  const missing = catalogue
    .browse({ kind: "workspace" })
    .children.filter((record) => record.kind === "project" && record.availability === "missing");
  const diagnostics = canvas.snapshot.roots.flatMap((root) =>
    root.evidence.status === "observed"
      ? root.evidence.observation.inventory.diagnostics.map((diagnostic) => ({
          entry: root.entry,
          location: diagnostic.location,
          reason: diagnostic.message,
        }))
      : [],
  );
  const services = canvas.railServices;
  const drift =
    rail.delivery.status?.projects.filter((project) => project.conflicts || project.updates || project.unavailable) ??
    [];
  const checks = projectSkills.flatMap((data) =>
    data.skills.flatMap((row) => {
      const project =
        canvas.snapshot.registry.projects.find((item) => item.ref.id === data.projectId)?.displayName ?? data.projectId;
      const intent = row.state === "update-available" ? maintenanceIntent(data.projectId, row) : undefined;
      const installedAgent = projectHarnesses.find((harness) => row.agents[harness].state === "installed");
      const missingAgents = projectHarnesses.filter(
        (harness) => row.agents[harness].state === "absent" && installedAgent !== undefined,
      );
      return [
        ...(intent
          ? [
              {
                key: `${data.projectId}:${row.id}:update`,
                title: t("rail.skillUpdate", { name: row.name }),
                where: project,
                action: t("projectView.updateAction"),
                intent,
              },
            ]
          : []),
        ...missingAgents.map((harness) => ({
          key: `${data.projectId}:${row.id}:${harness}`,
          title: t("rail.oneAgent", { name: row.name, agent: harnessLabel(installedAgent!) }),
          where: `${project} — ${t("rail.otherAgentCannotSee")}`,
          action: t("rail.installFor", { agent: harnessLabel(harness) }),
          intent: projectSkillIntent(data.projectId, row, "install-agent", harness),
        })),
      ];
    }),
  );
  const loadedDiagnostics = projectSkills.flatMap((data) =>
    data.diagnostics.map((diagnostic) => ({
      entry: { kind: "project" as const, id: data.projectId },
      location: diagnostic.location,
      reason: diagnostic.message,
    })),
  );
  const located = [
    ...new Map([...diagnostics, ...loadedDiagnostics].map((item) => [JSON.stringify(item), item])).values(),
  ];
  function navigate(route: Parameters<typeof canvas.onNavigate>[0]): void {
    rail?.close();
    canvas.onNavigate(route);
  }
  return (
    <>
      <SheetFrame
        title={t("canvas.review")}
        kicker={
          <>
            {t("canvas.review")} <Glossary concept="inbox" />
          </>
        }
        testId="canvas-review-sheet"
        busy={false}
        onClose={rail.close}
      >
        <section className="rail-section">
          {drift.map((project) => (
            <div className="rail-item" key={`drift:${project.projectId}`}>
              <div className="grow">
                <strong>
                  {canvas.snapshot.registry.projects.find((entry) => entry.ref.id === project.projectId)?.displayName ??
                    project.projectId}
                </strong>
                <p>
                  {[
                    project.conflicts ? translateCount(t, "delivery.conflicts", project.conflicts) : null,
                    project.updates ? translateCount(t, "delivery.updates", project.updates) : null,
                    project.unavailable ? translateCount(t, "delivery.unread", project.unavailable) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                className="canvas-secondary-button"
                type="button"
                onClick={() => {
                  rail.close();
                  canvas.onNavigate({
                    screen: "resource-canvas",
                    context: { kind: "entry", entry: { kind: "project", id: project.projectId } },
                    initialProjectSheet: "project",
                  });
                }}
              >
                {t("delivery.openProjects")}
              </button>
            </div>
          ))}
          <h3>{t("rail.requests")}</h3>
          <LoadingBoundary
            loading={requests.loading}
            label={t("canvas.loadingSurface", { surface: t("rail.requests") })}
            minHeight={216}
          >
            {requests.error ? (
              <AgentRequestsError t={t} />
            ) : requests.loading ? (
              <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("canvas.review") })} variant="rows" />
            ) : !requests.requests.length ? (
              <p>{t("rail.requestsEmpty")}</p>
            ) : (
              requests.requests.map((request) => (
                <div className="rail-item" key={request.requestId}>
                  <span className="rail-tile is-review">
                    <CanvasGlyph name="skill" />
                  </span>
                  <div>
                    <strong>{agentRequestAction(request, t)}</strong>
                    <small>
                      {agentRequesterLabel(request, t)} · {agentRelativeTime(request.createdAt, t)}
                    </small>
                    <p>{agentApprovalReason(request.approvalReason, t)}</p>
                  </div>
                  <button
                    className="canvas-secondary-button is-small is-primary"
                    type="button"
                    onClick={() => navigate(agentRequestRoute(request))}
                  >
                    {t("rail.open")}
                  </button>
                </div>
              ))
            )}
            <p className="sh-sub">{t("rail.requestsExplanation")}</p>
          </LoadingBoundary>
        </section>
        <section className="rail-section">
          <h3>{t("rail.checks")}</h3>
          {rail.maintenance.state.failures.map((failure) => (
            <div className="rail-item" key={failure.harness}>
              <span className="rail-tile is-review">
                <CanvasGlyph name="warn" />
              </span>
              <div>
                <strong>{t("agentSettings.failure", { agent: harnessLabel(failure.harness) })}</strong>
                <small>{failure.reason}</small>
              </div>
              <button
                className="canvas-secondary-button is-small"
                type="button"
                disabled={rail.maintenance.state.updating.includes(failure.harness)}
                onClick={() => void rail.maintenance.retry(failure.harness)}
              >
                {t("agentSettings.retry")}
              </button>
            </div>
          ))}
          <StorefrontReviewChecks />
          <ExternalReviewChecks />
          {rail.maintenance.error ? <p role="alert">{rail.maintenance.error}</p> : null}
          {rail.usesUnavailable ? <p role="alert">{t("rail.usesUnavailable")}</p> : null}
          {!rail.externalLibrary.review.length &&
          !checks.length &&
          !missing.length &&
          !located.length &&
          !rail.maintenance.state.failures.length &&
          !rail.storefronts.drift?.storefronts.some((storefront) => storefront.behind) ? (
            <p>{t("rail.checksEmpty")}</p>
          ) : null}
          {checks.map((check) => (
            <div className="rail-item" key={check.key}>
              <span className="rail-tile is-pending">
                <CanvasGlyph name="warn" />
              </span>
              <div>
                <strong>{check.title}</strong>
                <small>{check.where}</small>
              </div>
              <button
                className="canvas-secondary-button"
                type="button"
                onClick={() =>
                  navigate({
                    screen: "resource-canvas",
                    context: { kind: "workspace" },
                    initialSkillIntent: check.intent,
                  })
                }
              >
                {check.action}
              </button>
            </div>
          ))}
          {missing.length ? (
            <div className="rail-item">
              <span className="rail-tile is-pending">
                <CanvasGlyph name="warn" />
              </span>
              <div>
                <strong>{tCount("projectView.missingFolders", missing.length, {}, language)}</strong>
                <small>{missing.map((item) => item.label).join(", ")}</small>
              </div>
              <button className="canvas-secondary-button" type="button" onClick={() => setMissingOpen(true)}>
                {t("projectView.removeFromWorkspace")}
              </button>
            </div>
          ) : null}
          {located.map((diagnostic, index) => (
            <div className="rail-item" key={index}>
              <span className="rail-tile is-pending">
                <CanvasGlyph name="warn" />
              </span>
              <div>
                <strong>
                  {canvas.snapshot.registry.projects.find((item) => item.ref.id === diagnostic.entry.id)?.displayName ??
                    canvas.snapshot.registry.sources.find((item) => item.ref.id === diagnostic.entry.id)?.displayName ??
                    diagnostic.entry.id}{" "}
                  · <code>{diagnostic.location}</code>
                </strong>
                <small>{diagnostic.reason}</small>
              </div>
            </div>
          ))}
          <p className="rail-note">{t("rail.sessionOnly")}</p>
        </section>
        {services ? (
          <>
            <details className="rail-section" onToggle={(event) => setPendingOpen(event.currentTarget.open)}>
              <summary>{t("review.pending.title")}</summary>
              {pendingOpen ? <RailPendingBindings canvas={canvas} onNavigate={navigate} /> : null}
            </details>
            <details className="rail-section">
              <summary>{t("review.findingsTitle")}</summary>
              <button
                className="canvas-secondary-button"
                type="button"
                data-testid="canvas-run-audit"
                disabled={!services.api || !services.audit.start}
                onClick={() =>
                  services.audit.status === "running" ? services.audit.cancel?.() : services.audit.start?.()
                }
              >
                {t(services.audit.status === "running" ? "onboarding.audit.cancel" : "rail.runAudit")}
              </button>
              <Findings
                api={services.api}
                audit={services.audit}
                groups={groupReviewFindings(services.audit.report, canvas.snapshot.registry)}
                onNavigateToEntry={(entry) =>
                  navigate({ screen: "resource-canvas", context: { kind: "entry", entry } })
                }
                onNavigateToRoute={navigate}
                t={t}
              />
            </details>
          </>
        ) : null}
      </SheetFrame>
      {missingOpen ? (
        <MissingProjectsSheet
          projects={missing}
          canvas={canvas}
          onClose={() => setMissingOpen(false)}
          onApplyingChange={props.onApplyingChange}
        />
      ) : null}
    </>
  );
}
