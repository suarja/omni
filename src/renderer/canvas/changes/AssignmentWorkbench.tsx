import { harnessLabel } from "../project-view-model";
import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { Binding, ProjectPlan } from "../../../domain/assignment-plan";
import type { HarnessId } from "../../../domain/harness-targets";
import type { ObservedArtifact } from "../../../domain/inventory";
import type { Observation, RegistryEntryView, SourceEntryView } from "../../../domain/project-source-registry";
import type { BindingsPreviewUnit } from "../../../shared/bindings-ipc";
import type { DesktopApi } from "../../../shared/ipc";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import type { AuditReport } from "../../audit/audit-report";
import type { CatalogueUnit } from "../../catalogue/catalogue";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Callout";
import { WorkflowFooter } from "./WorkflowFooter";
import { IconWrap } from "../../components/ui/IconWrap";
import { ItemList, ListItem } from "../../components/ui/ItemList";
import { SectionHeading } from "../../components/ui/SectionHeading";
import { useI18n } from "../../i18n";
import type { Route } from "../../navigation";
import { useAgentRequestPreview } from "../../operations/use-agent-request-preview";
import { AgentPreviewUpdated } from "../../operations/AgentPreviewUpdated";
import { AgentRequestBanner } from "../../operations/AgentRequestBanner";
import { AssignmentOutcome, type AssignmentConflict } from "./AssignmentOutcome";
import { assignmentPreviewFingerprint, buildBindingsToSave } from "../../operations/assignment-page-helpers";
import {
  authorizeAssignmentRequest,
  completeAssignmentRequest,
  recordAssignmentFailure,
  releaseAssignmentRequest,
  type AssignmentAuthorization,
} from "../../operations/assignment-agent-outcome";
import {
  WhatWillBeAdded,
  AssignmentPlanCard,
  HARNESSES,
  HarnessCheckboxRow,
  type ObservationCache,
  observedForProject,
  resolveHarnessTarget,
} from "../../operations/assignment-plan-view";

type Project = RegistryEntryView<"project">;

export type AssignmentWorkbenchProps = Readonly<{
  api:
    | (Pick<DesktopApi, "previewBindings" | "saveBindings" | "previewApply" | "runApply"> &
        Partial<
          Pick<
            DesktopApi,
            | "refreshAgentRequest"
            | "resolveAgentRequest"
            | "listAgentRequests"
            | "declineAgentRequest"
            | "beginAgentApply"
            | "endAgentApply"
          >
        >)
    | null;
  existingBindings?: readonly Binding[];
  // Omitted: assign every artifact of the package (whole-plugin assignment).
  artifactPath?: string;
  packageId: string;
  packageName: string;
  summary?: string;
  // The package's artifacts, for the "What will be added" card of a whole-plugin assignment.
  packageArtifacts?: readonly ObservedArtifact[];
  projects: readonly Project[];
  source: SourceEntryView;
  // Present only for a single-artifact assignment.
  unit?: CatalogueUnit;
  observations?: ObservationCache;
  auditReport?: AuditReport | null;
  preselectProjectId?: string;
  onEnsureGrant: (ref: { kind: "project" | "source"; id: string }) => Promise<string | null>;
  onBindingsChanged?: () => void;
  onNavigate: (route: Route) => void;
  returnTo: Route;
  requestId?: string;
}>;

function projectBadges(observation: Observation | undefined): ReactElement | null {
  if (!observation?.inventory.harnesses.length) return null;
  return (
    <span className="assignment-harness-badges">
      {observation.inventory.harnesses.map((harness) => (
        <Badge key={harnessLabel(harness)} variant="type">
          {harnessLabel(harness)}
        </Badge>
      ))}
    </span>
  );
}

export function AssignmentWorkbench({
  api,
  artifactPath,
  auditReport,
  existingBindings = [],
  onBindingsChanged,
  onEnsureGrant,
  onNavigate,
  observations = {},
  packageArtifacts = [],
  packageId,
  packageName,
  preselectProjectId,
  projects,
  returnTo,
  source,
  summary,
  unit,
  requestId,
}: AssignmentWorkbenchProps): ReactElement {
  const { language, t } = useI18n();
  const agentPreview = useAgentRequestPreview(api, api?.listAgentRequests ? requestId : undefined);
  const [selectedProjectIds, setSelectedProjectIds] = useState<readonly string[]>(
    preselectProjectId ? [preselectProjectId] : [],
  );
  const [selectedHarnessIds, setSelectedHarnessIds] = useState<readonly HarnessId[]>([]);
  const [plans, setPlans] = useState<readonly ProjectPlan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCounts, setSavedCounts] = useState<{ projects: number; harnesses: number } | null>(null);
  const [applyRequested, setApplyRequested] = useState(false);
  const [receipts, setReceipts] = useState<readonly OperationReceipt[]>([]);
  const [conflictProject, setConflictProject] = useState<AssignmentConflict | null>(null);
  const [failedReceipt, setFailedReceipt] = useState<OperationReceipt | null>(null);
  const [previewUnits, setPreviewUnits] = useState<readonly BindingsPreviewUnit[]>([]);
  const sequence = useRef(0);
  const selectedProjects = useMemo(
    () => projects.filter((project) => selectedProjectIds.includes(project.ref.id)),
    [projects, selectedProjectIds],
  );
  const detectedHarnesses = useMemo(
    () =>
      HARNESSES.filter((harness) =>
        selectedProjects.some((project) =>
          observedForProject(project.ref.id, observations, auditReport)?.inventory.harnesses.includes(harness),
        ),
      ),
    [auditReport, observations, selectedProjects],
  );

  useEffect(() => {
    const stored = agentPreview.request;
    const requested = stored?.request;
    if (requested?.kind !== "assign") return;
    setSelectedProjectIds(requested.projectIds);
    const harnesses =
      stored?.plan.kind === "assign"
        ? stored.plan.plans.flatMap((plan) => plan.actions.map((action) => action.harnessId))
        : [];
    setSelectedHarnessIds([...new Set(harnesses.length ? harnesses : (["claude-code", "codex"] as const))]);
  }, [agentPreview.request]);

  useEffect(() => {
    if (requestId) return;
    setSelectedHarnessIds((current) => {
      const next = [...new Set([...current, ...detectedHarnesses])];
      return next.length === current.length ? current : next;
    });
  }, [detectedHarnesses, requestId]);

  useEffect(() => {
    const requestSequence = sequence.current + 1;
    sequence.current = requestSequence;
    setPlans([]);
    setError(null);
    const previewBindings = api?.previewBindings;
    if (!previewBindings || !selectedProjectIds.length || !selectedHarnessIds.length) return;
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        const sourceGrant = await onEnsureGrant({ kind: "source", id: source.ref.id });
        if (!sourceGrant) throw new Error(t("assignment.grantUnavailable"));
        const projectRequests = [];
        for (const projectId of selectedProjectIds) {
          const grant = await onEnsureGrant({ kind: "project", id: projectId });
          if (!grant) throw new Error(t("assignment.grantUnavailable"));
          projectRequests.push({ projectId, grantHandle: grant, harnessIds: selectedHarnessIds });
        }
        if (sequence.current !== requestSequence) return;
        const response = await previewBindings({
          source: { id: source.ref.id, grantHandle: sourceGrant },
          packageId,
          ...(artifactPath ? { artifactPath } : {}),
          projects: projectRequests,
        });
        if (sequence.current !== requestSequence) return;
        if (response.status === "denied") throw new Error(t("assignment.previewUnavailable"));
        setPreviewUnits(response.units);
        setPlans(response.plans);
      })().catch((previewError: unknown) => {
        if (sequence.current === requestSequence)
          setError(previewError instanceof Error ? previewError.message : t("assignment.previewUnavailable"));
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [api, artifactPath, onEnsureGrant, packageId, selectedHarnessIds, selectedProjectIds, source.ref.id, t]);

  const blocked = plans.some((plan) => plan.status === "blocked");
  const toggleProject = (projectId: string): void =>
    setSelectedProjectIds((current) =>
      current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId],
    );
  const toggleHarness = (harnessId: HarnessId): void =>
    setSelectedHarnessIds((current) =>
      current.includes(harnessId) ? current.filter((id) => id !== harnessId) : [...current, harnessId],
    );
  const save = (applyNow: boolean): void => {
    const saveBindings = api?.saveBindings;
    const previewBindings = api?.previewBindings;
    const previewApply = api?.previewApply;
    const runApply = api?.runApply;
    if (saving || !saveBindings || !previewBindings || !previewApply || !runApply || blocked || !plans.length) return;
    setSaving(true);
    setApplyRequested(applyNow);
    setError(null);
    setConflictProject(null);
    setReceipts([]);
    setFailedReceipt(null);
    const bindings = buildBindingsToSave(plans, previewUnits, source, packageId, existingBindings);
    const counts = { projects: selectedProjectIds.length, harnesses: selectedHarnessIds.length };
    void (async (): Promise<void> => {
      const completed: OperationReceipt[] = [];
      let bindingsSaved = false;
      let failedOperation: OperationReceipt | undefined;
      let sequenceCompleted = false;
      let authorization: AssignmentAuthorization | undefined;
      let currentProjectName: string | undefined;
      try {
        authorization = await authorizeAssignmentRequest(api ?? {}, requestId);
        currentProjectName =
          selectedProjects.map((project) => project.displayName || project.displayRoot).join(", ") ||
          t("assignment.projects");
        const sourceGrant = await onEnsureGrant(source.ref);
        if (!sourceGrant) throw new Error(t("assignment.grantUnavailable"));
        const freshProjects = [];
        for (const project of selectedProjects) {
          const grantHandle = await onEnsureGrant(project.ref);
          if (!grantHandle) throw new Error(t("assignment.grantUnavailable"));
          freshProjects.push({ projectId: project.ref.id, grantHandle, harnessIds: selectedHarnessIds });
        }
        const freshPreview = await previewBindings({
          source: { id: source.ref.id, grantHandle: sourceGrant },
          packageId,
          ...(artifactPath ? { artifactPath } : {}),
          projects: freshProjects,
        });
        if (freshPreview.status !== "ready") throw new Error(t("assignment.previewUnavailable"));
        if (
          assignmentPreviewFingerprint(plans, previewUnits) !==
          assignmentPreviewFingerprint(freshPreview.plans, freshPreview.units)
        ) {
          if (requestId && api?.refreshAgentRequest) {
            await agentPreview.refresh();
            agentPreview.markUpdated();
          }
          setPlans(freshPreview.plans);
          setPreviewUnits(freshPreview.units);
          throw new Error(t("assignment.previewChanged", { project: currentProjectName }));
        }
        const savedResponse = await saveBindings({ bindings });
        if (savedResponse.status !== "ready") throw new Error(t("assignment.saveFailed"));
        bindingsSaved = true;
        onBindingsChanged?.();
        if (!applyNow) {
          setSavedCounts(counts);
          setSaved(true);
          return;
        }
        for (const plan of plans) {
          currentProjectName =
            projects.find((project) => project.ref.id === plan.projectId)?.displayName ?? plan.projectId;
          const bindingIds = bindings
            .filter((binding) => binding.projectId === plan.projectId)
            .map((binding) => binding.bindingId);
          if (!bindingIds.length) throw new Error(t("assignment.applyFailed", { project: plan.projectId }));
          const grant = await onEnsureGrant({ kind: "project", id: plan.projectId });
          if (!grant) throw new Error(t("assignment.grantUnavailable"));
          const preview = await previewApply({
            projectId: plan.projectId,
            grantHandle: grant,
            sourceGrantHandle: sourceGrant,
            bindingIds,
          });
          if (preview.status === "blocked") throw new Error(preview.diagnostic ?? preview.reason);
          const unresolved = preview.actions.some((action) => action.needsResolution);
          if (unresolved) {
            setReceipts(completed);
            setConflictProject({ projectId: plan.projectId, bindingIds });
            setSavedCounts(counts);
            setSaved(true);
            return;
          }
          const result = await runApply({ planId: preview.planId, resolutions: [] });
          if (result.status === "blocked") throw new Error(result.diagnostic ?? result.reason);
          if (result.receipt.status !== "applied") {
            failedOperation = result.receipt;
            setFailedReceipt(result.receipt);
            throw new Error(result.receipt.diagnostic ?? t("assignment.applyFailed", { project: plan.projectId }));
          }
          completed.push(result.receipt);
        }
        setReceipts(completed);
        sequenceCompleted = true;
        await completeAssignmentRequest(api ?? {}, requestId, completed, authorization);
        setSavedCounts(counts);
        setSaved(true);
      } catch (saveError: unknown) {
        setReceipts(completed);
        const detail = saveError instanceof Error ? saveError.message : t("assignment.saveFailed");
        const contextualDetail = currentProjectName
          ? `${t(bindingsSaved ? "assignment.applyFailed" : "assignment.projectContext", { project: currentProjectName })} ${detail}`
          : detail;
        const recordedReceipts = failedOperation ? [...completed, failedOperation] : completed;
        if (requestId && recordedReceipts.length && !sequenceCompleted) {
          try {
            await recordAssignmentFailure(api ?? {}, requestId, recordedReceipts, detail, authorization);
          } catch {
            setError(`${contextualDetail} ${t("assignment.saveFailed")}`);
          }
        }
        setError((current) => current ?? contextualDetail);
        if (bindingsSaved) {
          setSavedCounts(counts);
          setSaved(true);
        }
      } finally {
        await releaseAssignmentRequest(api ?? {}, requestId, authorization).catch(() =>
          setError((current) => current ?? t("assignment.saveFailed")),
        );
        setSaving(false);
      }
    })();
  };
  const [saved, setSaved] = useState(false);
  if (saved)
    return (
      <WorkflowWorkbench
        title={t("assignment.applied")}
        busy={saving || agentPreview.busy}
        hasResult
        onClose={() => onNavigate(returnTo)}
        api={api}
      >
        <AssignmentOutcome
          applyRequested={applyRequested}
          conflictProject={conflictProject}
          error={error}
          failedReceipt={failedReceipt}
          onNavigate={onNavigate}
          receipts={receipts}
          returnTo={returnTo}
          savedCounts={savedCounts}
        />
      </WorkflowWorkbench>
    );
  return (
    <WorkflowWorkbench
      title={unit ? t("assignment.use", { name: unit.name }) : t("assignment.addPlugin", { name: packageName })}
      subtitle={projects.find((project) => project.ref.id === preselectProjectId)?.displayName ?? source.displayName}
      busy={saving || agentPreview.busy}
      hasResult={saved}
      onClose={() => onNavigate(returnTo)}
      receipt={undefined}
      onNavigate={onNavigate}
      targets={
        <div className="assignment-previews">
          {plans.map((plan) => (
            <div key={plan.projectId}>
              <AssignmentPlanCard
                plan={plan}
                projectName={
                  projects.find((project) => project.ref.id === plan.projectId)?.displayName || plan.projectId
                }
                t={t}
              />
            </div>
          ))}
        </div>
      }
      footer={
        <WorkflowFooter
          note={t("assignment.nothingWritten")}
          actions={
            <>
              <Button dataTestId="assignment-back" onClick={() => onNavigate(returnTo)} tone="ghost">
                {t("operations.back")}
              </Button>
              <Button
                dataTestId="assignment-apply-now"
                disabled={saving || agentPreview.busy || Boolean(agentPreview.error) || blocked || !plans.length}
                onClick={() => save(true)}
              >
                {t("assignment.applyNow")}
              </Button>
              <Button
                dataTestId="assignment-save"
                disabled={saving || agentPreview.busy || Boolean(agentPreview.error) || blocked || !plans.length}
                onClick={() => save(false)}
                tone="secondary"
              >
                {t("assignment.saveForLater")}
              </Button>
            </>
          }
        />
      }
      api={api}
      notice={
        <>
          <AgentRequestBanner api={api} applying={saving} requestId={requestId} />
          <AgentPreviewUpdated visible={agentPreview.updated} />
        </>
      }
    >
      <div data-testid="assignment-page">
        {summary ? <p className="changes-note">{summary}</p> : null}
        {agentPreview.error ? (
          <Callout title={t("assignment.previewUnavailable")} tone="error">
            {agentPreview.error}
          </Callout>
        ) : null}
        {error ? (
          <Callout title={t("assignment.previewUnavailable")} tone="error">
            {error}
          </Callout>
        ) : null}
        {unit ? null : <WhatWillBeAdded artifacts={packageArtifacts} language={language} t={t} />}
        <section>
          <SectionHeading count={projects.length} title={t("assignment.projects")} />
          <ItemList>
            {projects.map((project) => (
              <ListItem
                ariaPressed={selectedProjectIds.includes(project.ref.id)}
                dataTestId={`assignment-project-${project.ref.id}`}
                key={project.ref.id}
                leading={<IconWrap name="folder" size="sm" />}
                name={project.displayName || project.displayRoot}
                side={projectBadges(observedForProject(project.ref.id, observations, auditReport))}
                selected={selectedProjectIds.includes(project.ref.id)}
                sub={<code>{project.displayRoot}</code>}
                onClick={() => toggleProject(project.ref.id)}
              />
            ))}
          </ItemList>
        </section>
        <section>
          <SectionHeading title={t("assignment.harnesses")} />
          <ItemList>
            {HARNESSES.map((harnessId) => {
              // A whole-plugin assignment mixes artifact kinds, so no single kind decides whether a
              // harness is offered; per-artifact blocked states still surface in the plan preview.
              const target = unit ? resolveHarnessTarget(unit.kind, unit.name, harnessId) : undefined;
              const disabled = target?.status === "blocked";
              return (
                <HarnessCheckboxRow
                  blockedReason={target?.status === "blocked" ? target.reason : undefined}
                  checkboxTestId={`assignment-harness-${harnessId}`}
                  dataTestId={`assignment-harness-row-${harnessId}`}
                  disabled={disabled}
                  harnessId={harnessId}
                  key={harnessId}
                  checked={selectedHarnessIds.includes(harnessId)}
                  onChange={() => toggleHarness(harnessId)}
                  t={t}
                />
              );
            })}
          </ItemList>
        </section>
      </div>
    </WorkflowWorkbench>
  );
}
