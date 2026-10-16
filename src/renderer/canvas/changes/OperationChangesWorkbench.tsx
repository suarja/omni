import { useEffect, useRef, useState, type ReactElement } from "react";
import { SheetFrame } from "../SheetFrame";
import type { DesktopApi } from "../../../shared/ipc";
import type { SkillIntent, SkillResult } from "../../../shared/skill-management-ipc";
import type { SkillManagedResolutionChoice } from "../../../shared/skill-reconciliation-request";
import type { ManagedResolutionSelection } from "../use-canvas-changes";
import type { WriteSkillRequest } from "../../../shared/operations-write-skill-ipc";
import type { SourceSkillRef } from "../../../domain/skill-reconciliation/types";
import type { SkillVariantDestination } from "../skill-variant-destinations";
import { useI18n } from "../../i18n";
import { AgentPreviewUpdated } from "../../operations/AgentPreviewUpdated";
import { AgentRequestBanner } from "../../operations/AgentRequestBanner";
import { AssignmentTargets, type AssignmentArtifactChoice, type AssignmentProjectChoice } from "./AssignmentTargets";
import { ChangesDiff } from "./ChangesDiff";
import { ChangesTargets } from "./ChangesTargets";
import { ChangesResult } from "./ChangesResult";
import { ManagedResolutionControls } from "./ManagedResolutionControls";
import { reconciliationModes, reconciliationTitleKey } from "./reconciliation-mode";
import { useSkillOperation } from "./use-skill-operation";
import { propagationRetryIntent, readySteps } from "./operation-view-model";
import { WorkbenchActions } from "./WorkbenchActions";
import { usePropagationWorkbench } from "./propagation/use-propagation-workbench";
import { PropagationFooter } from "./propagation/PropagationFooter";
import { PropagationCompare } from "./propagation/PropagationCompare";
import { PropagationProjects } from "./propagation/PropagationProjects";
import { PropagationResult } from "./propagation/PropagationResult";
import { PropagationRestore } from "./propagation/PropagationRestore";
import { WorkbenchTabs } from "./WorkbenchTabs";
import "./changes.css";
import "./copy-management.css";
import "./propagation/propagation.css";

export type ChangesSourceChoice = Readonly<{ id: string; name: string }>;
export type ChangesPackageChoice = Readonly<{ id: string; sourceId: string; name: string }>;
type Tab = "diff" | "targets" | "result";
type ChangesApi = Pick<
  DesktopApi,
  "previewSkillOperation" | "refreshSkillOperation" | "applySkillOperation" | "readSkillOperationResult"
> &
  Partial<
    Pick<
      DesktopApi,
      | "listSkillOperationRecoveries"
      | "onReviewChanged"
      | "refreshAgentRequest"
      | "listAgentRequests"
      | "declineAgentRequest"
    >
  >;

export type OperationChangesWorkbenchProps = Readonly<{
  api: ChangesApi | null;
  sourceId?: string;
  packageId?: string;
  sources: readonly ChangesSourceChoice[];
  packages: readonly ChangesPackageChoice[];
  artifacts: readonly AssignmentArtifactChoice[];
  projects: readonly AssignmentProjectChoice[];
  initialRequest?: WriteSkillRequest;
  initialSkillIntent?: SkillIntent;
  initialSkillIntentId?: string;
  initialManagedResolution?: ManagedResolutionSelection;
  initialResultId?: string;
  requestId?: string;
  initialProjectId?: string;
  initialRemovalBindingIds?: readonly string[];
  initialRestoreOperationId?: string;
  initialJourney: "draft" | "assign";
  onClose: () => void;
  onBack?: () => void;
  onSourceChanged: () => void;
  onResult?: (result: SkillResult) => void;
  onAdoptionChanged?: () => Promise<void>;
  onConnectAgent?: (opener: HTMLElement) => void;
  onApplyingChange?: (active: boolean) => void;
  onOpenVariant?: (source: SourceSkillRef) => void | Promise<void>;
  variantDestinations?: readonly SkillVariantDestination[];
}>;

export function OperationChangesWorkbench(props: OperationChangesWorkbenchProps): ReactElement {
  const { t } = useI18n();
  const operation = useSkillOperation(props.api, props.requestId);
  const propagation = usePropagationWorkbench(operation);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<Tab>(
    props.initialResultId
      ? "result"
      : props.initialJourney === "assign" && !props.initialManagedResolution && !props.initialSkillIntent
        ? "targets"
        : "diff",
  );
  const [recoveries, setRecoveries] = useState<readonly SkillResult[]>([]);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [restoreOriginalResult, setRestoreOriginalResult] = useState<SkillResult | null>(null);
  const [dismissInitialRestore, setDismissInitialRestore] = useState(false);
  const [resolutionChoice, setResolutionChoice] = useState<SkillManagedResolutionChoice | "keep-variant" | undefined>();
  const resolutionContextKey = props.initialManagedResolution
    ? JSON.stringify([props.initialManagedResolution.skillId, props.initialManagedResolution.location])
    : undefined;
  const previousResolutionContextKey = useRef(resolutionContextKey);
  const steps = readySteps(operation.preview);
  const preview = operation.preview;
  const restoreMode =
    operation.intent?.kind === "restore" || (Boolean(props.initialRestoreOperationId) && !dismissInitialRestore);
  const removalMode = operation.intent?.kind === "remove" || Boolean(props.initialRemovalBindingIds?.length);
  const detachmentRestoreMode = steps.some((step) => Boolean(step.detachmentRestoreOrigin));
  const modes = reconciliationModes(
    operation.intent,
    Boolean(props.initialManagedResolution),
    resolutionChoice === "keep-variant",
  );
  const nameFor = (id: string): string =>
    props.sources.find((source) => source.id === id)?.name ??
    props.projects.find((project) => project.id === id)?.name ??
    id;

  useEffect(() => {
    closeRef.current?.focus();
    if (props.initialResultId) {
      void operation.loadResult(props.initialResultId);
      return;
    }
    if (props.initialSkillIntent) {
      if (props.initialSkillIntentId || props.requestId)
        void operation.resume(props.initialSkillIntent, props.initialSkillIntentId);
      else void operation.inspect(props.initialSkillIntent);
      return;
    }
    if (props.initialRequest) void operation.inspect({ kind: "write", request: props.initialRequest });
    else if (props.initialRemovalBindingIds?.length)
      void operation.inspect({ kind: "remove", bindingIds: props.initialRemovalBindingIds });
    else if (props.initialRestoreOperationId) {
      let active = true;
      const inspectRestore = (): void => {
        if (!active) return;
        void operation.inspect({ kind: "restore", operationId: props.initialRestoreOperationId! });
      };
      if (props.api?.readSkillOperationResult)
        void props.api
          .readSkillOperationResult({ intentId: props.initialRestoreOperationId })
          .then((result) => {
            if (!active) return;
            setRestoreOriginalResult(result ?? null);
            propagation.retainResult(result);
            inspectRestore();
          })
          .catch(inspectRestore);
      else inspectRestore();
      return () => {
        active = false;
      };
    }
  }, [
    operation.inspect,
    operation.resume,
    operation.loadResult,
    props.initialRequest,
    props.initialResultId,
    props.initialRemovalBindingIds,
    props.initialRestoreOperationId,
    props.initialSkillIntent,
    props.initialSkillIntentId,
    props.requestId,
    props.api,
    propagation.retainResult,
  ]);
  useEffect(() => {
    if (previousResolutionContextKey.current === resolutionContextKey) return;
    previousResolutionContextKey.current = resolutionContextKey;
    setResolutionChoice(undefined);
    operation.clearReview();
    setTab("diff");
  }, [operation.clearReview, resolutionContextKey]);
  useEffect(() => {
    let active = true;
    const load = (): void => {
      void props.api
        ?.listSkillOperationRecoveries?.()
        .then((saved) => {
          if (active) {
            setRecoveries(saved);
            setRecoveryUnavailable(false);
          }
        })
        .catch(() => {
          if (active) setRecoveryUnavailable(true);
        });
    };
    load();
    const unsubscribe = props.api?.onReviewChanged?.(load);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [props.api]);
  useEffect(() => {
    props.onApplyingChange?.(operation.applying);
    return () => props.onApplyingChange?.(false);
  }, [operation.applying, props.onApplyingChange]);

  const startRestore = (operationId: string): void => {
    if (operation.busy) return;
    propagation.retainResult(operation.result ?? undefined);
    setRestoreOriginalResult(operation.result);
    setDismissInitialRestore(false);
    operation.clearReview();
    setTab("diff");
    void operation.inspect({ kind: "restore", operationId });
  };
  const cancelPropagationRestore = (): void => {
    if (!restoreOriginalResult || operation.busy) return;
    setDismissInitialRestore(true);
    setTab("result");
    operation.clearReview();
    void operation.loadResult(restoreOriginalResult.intentId);
  };
  const retryPropagation = (target: Parameters<typeof propagationRetryIntent>[2]): void => {
    const intent = propagationRetryIntent(operation.result, operation.busy, target);
    if (!intent) return;
    propagation.retainOriginal();
    setTab("diff");
    void operation.inspect(intent);
  };
  const chooseResolution = (choice: SkillManagedResolutionChoice | "keep-variant"): void => {
    if (choice === "keep-variant") {
      if (resolutionChoice === choice) return;
      setResolutionChoice(choice);
      operation.clearReview();
      setTab("diff");
      return;
    }
    const selected = props.initialManagedResolution;
    if (!selected || operation.busy) return;
    if (resolutionChoice === choice && operation.intent?.kind === "reconcile") return;
    setResolutionChoice(choice);
    operation.clearReview();
    setTab("diff");
    void operation.inspect({
      kind: "reconcile",
      request: { choice, skillId: selected.skillId, locations: [selected.location] },
    });
  };
  const apply = async (): Promise<void> => {
    const result = await operation.apply();
    if (!result) return;
    props.onResult?.(result);
    setTab("result");
    const adoptionEffect =
      (modes.adoption && !modes.variantCapture) ||
      (operation.intent?.kind === "restore" && result.resolution !== undefined);
    if (adoptionEffect) {
      if (result.status !== "no-op" && result.status !== "cancelled") await props.onAdoptionChanged?.();
    } else if (
      ["created", "updated", "restored"].includes(result.source.status) ||
      result.targets.some((target) => ["applied", "removed", "restored"].includes(target.status))
    )
      props.onSourceChanged();
  };
  const propagationSource = propagation.summary?.source;
  const propagationTitle =
    props.artifacts.find(
      (item) =>
        item.sourceId === propagationSource?.sourceId &&
        item.packageId === propagationSource.packageId &&
        item.artifactPath.replace(/\/SKILL\.md$/u, "") === propagationSource.artifactPath,
    )?.name ?? propagationSource?.artifactPath.split("/").at(-1);
  const title = propagationTitle ?? t(reconciliationTitleKey(modes, restoreMode, removalMode));
  const choosingTargets =
    !preview &&
    !operation.result &&
    !propagation.summary &&
    props.initialJourney === "assign" &&
    !removalMode &&
    !restoreMode &&
    !modes.managedResolution;
  const findings = steps.flatMap((step) => step.plan.findings ?? []);

  return (
    <SheetFrame
      title={title}
      label={t("skillManagement.title")}
      kicker={
        operation.result?.source.sourceId
          ? nameFor(operation.result.source.sourceId)
          : preview?.status === "ready" && preview.scope.sourceId
            ? nameFor(preview.scope.sourceId)
            : t("skillManagement.title")
      }
      subtitle={
        propagation.summary ? (
          <div className="propagation-source">
            <span>{nameFor(propagation.summary.source.sourceId)}</span>
            <span>
              {t(
                restoreMode && propagation.view?.sourceUpdate
                  ? "skillManagement.propagationRestoreSource"
                  : propagation.view?.sourceUpdate
                    ? "skillManagement.propagationSourceUpdate"
                    : "skillManagement.propagationSourceCurrent",
              )}
            </span>
          </div>
        ) : (
          (props.packageId ?? (preview?.status === "ready" ? preview.scope.packageId : undefined))
        )
      }
      testId="changes-workbench"
      className={`changes-workbench${propagation.summary ? " propagation-workbench" : ""}`}
      busy={operation.applying}
      onClose={props.onClose}
      closeRef={closeRef}
      closeLabel={t("skillManagement.close")}
      resizeKind="changes"
      headerClassName="changes-header"
      tabs={
        <WorkbenchTabs
          tab={tab}
          propagation={Boolean(propagation.summary)}
          hasResult={Boolean(operation.result)}
          hasPreview={Boolean(preview)}
          restoreMode={restoreMode}
          onChange={setTab}
          t={t}
        />
      }
      footer={
        propagation.view && !operation.result && !restoreMode ? (
          <PropagationFooter
            view={propagation.view}
            preview={preview}
            busy={operation.busy}
            t={t}
            refresh={operation.refresh}
            apply={apply}
          />
        ) : preview && !operation.result ? (
          <WorkbenchActions
            preview={preview}
            modes={modes}
            busy={operation.busy}
            applying={operation.applying}
            intent={operation.intent}
            restoreMode={restoreMode}
            propagationRestore={restoreMode && Boolean(propagation.summary)}
            removalMode={removalMode}
            detachmentRestoreMode={detachmentRestoreMode}
            t={t}
            onBack={props.onBack}
            onCancelRestore={cancelPropagationRestore}
            refresh={operation.refresh}
            apply={apply}
          />
        ) : null
      }
    >
      <AgentRequestBanner api={props.api} requestId={props.requestId} applying={operation.busy} />
      {operation.applying ? (
        <div aria-live="polite" className="changes-live-progress">
          <span>{t("skillManagement.statusApplying")}</span>
          {operation.progress?.targets.map((target) => (
            <p key={target.bindingId}>
              {nameFor(target.projectId)} · {target.harnessId}
              <span>
                {t(
                  target.status === "applied" || target.status === "removed" || target.status === "restored"
                    ? "skillManagement.outcomeApplied"
                    : target.status === "pending"
                      ? "skillManagement.outcomePending"
                      : "skillManagement.outcomeUnknown",
                )}
              </span>
            </p>
          ))}
        </div>
      ) : null}
      <div
        aria-labelledby={`changes-tab-${tab}`}
        className="changes-body"
        id={`changes-panel-${tab}`}
        role="tabpanel"
        tabIndex={0}
      >
        <AgentPreviewUpdated visible={operation.updatedAgentPreview} />
        {operation.error ? (
          <div className="changes-error" role="alert">
            <p>{operation.error}</p>
            {operation.errorDetail ? (
              <details className="changes-error-details">
                <summary>{t("errors.technicalDetails")}</summary>
                <code>{operation.errorDetail}</code>
              </details>
            ) : null}
          </div>
        ) : null}
        {recoveryUnavailable ? (
          <p className="changes-error" role="alert">
            {t("skillManagement.recoveryUnavailable")}
          </p>
        ) : null}
        <div hidden={tab !== "diff"}>
          <ManagedResolutionControls
            selection={restoreMode ? undefined : props.initialManagedResolution}
            value={resolutionChoice}
            reviewed={preview?.status === "ready"}
            disabled={operation.busy || operation.applying}
            canReview={!operation.busy && !operation.applying}
            destinations={props.variantDestinations ?? []}
            onChange={chooseResolution}
            onReviewCapture={(intent) => {
              setTab("diff");
              void operation.inspect(intent);
            }}
            onSelectionChanged={operation.clearReview}
            projectName={
              props.initialManagedResolution ? nameFor(props.initialManagedResolution.location.projectId) : ""
            }
          />
        </div>
        {choosingTargets ? (
          <AssignmentTargets
            artifacts={props.artifacts}
            busy={operation.busy}
            onInvalidate={operation.clearReview}
            onReview={(intent) => {
              setTab("diff");
              void operation.inspect(intent);
            }}
            packageId={props.packageId}
            packages={props.packages}
            projectId={props.initialProjectId}
            projects={props.projects}
            sourceId={props.sourceId}
            sources={props.sources}
          />
        ) : null}
        {restoreMode && propagation.summary && preview?.status === "ready" && tab === "diff" ? (
          <PropagationRestore summary={propagation.summary} preview={preview} nameFor={nameFor} t={t} />
        ) : propagation.summary && propagation.view && !restoreMode && !operation.result && tab === "diff" ? (
          <PropagationCompare summary={propagation.summary} view={propagation.view} nameFor={nameFor} t={t} />
        ) : preview?.status === "ready" && tab === "diff" ? (
          <>
            {findings.length ? (
              <ul className="changes-findings">
                {findings.map((finding) => (
                  <li key={`${finding.code}:${finding.message}`}>{finding.message}</li>
                ))}
              </ul>
            ) : null}
            <ChangesDiff steps={steps} nameFor={nameFor} propagation={preview.propagation} t={t} />
          </>
        ) : null}
        {propagation.summary && propagation.view && !restoreMode && !operation.result && tab === "targets" ? (
          <PropagationProjects
            summary={propagation.summary}
            view={propagation.view}
            nameFor={nameFor}
            t={t}
            disabled={operation.busy}
            onSelect={propagation.select}
          />
        ) : preview?.status === "ready" && tab === "targets" ? (
          <ChangesTargets scope={preview.scope} steps={steps} nameFor={nameFor} propagation={preview.propagation} />
        ) : null}
        {preview && preview.status !== "ready" ? (
          <>
            <p className="changes-error" role="alert">
              {preview.reason}
            </p>
            {preview.details
              .filter((detail) => detail.message !== preview.reason)
              .map((detail) => (
                <p className="changes-issue" key={`${detail.code}:${detail.message}`}>
                  {detail.message}
                </p>
              ))}
          </>
        ) : null}
        {operation.result && tab === "result" && propagation.summary && propagation.view ? (
          <PropagationResult
            result={operation.result}
            summary={propagation.summary}
            view={propagation.view}
            originals={propagation.originals}
            t={t}
            nameFor={nameFor}
            onRetry={retryPropagation}
            onRestore={startRestore}
            onOpenOriginal={propagation.openOriginal}
          />
        ) : operation.result && tab === "result" ? (
          <ChangesResult
            result={operation.result}
            onRestore={startRestore}
            onRetryPropagation={retryPropagation}
            onOpenVariant={props.onOpenVariant}
            nameFor={nameFor}
            t={t}
          />
        ) : null}
        {operation.result && props.onBack ? (
          <button className="changes-secondary" onClick={props.onBack} type="button">
            {t("skillManagement.backToCopies")}
          </button>
        ) : null}
        {!preview && operation.busy ? (
          <p className="changes-note" role="status">
            {t("skillManagement.loading")}
          </p>
        ) : null}
        {!preview && recoveries.length ? (
          <section className="changes-recoveries">
            <h3>{t("skillManagement.pendingRecovery")}</h3>
            {recoveries.map((result) => (
              <button
                className="changes-secondary"
                key={result.intentId}
                disabled={operation.busy}
                onClick={() => {
                  setTab("result");
                  void operation.loadResult(result.intentId);
                }}
                type="button"
              >
                {result.source.sourceId
                  ? nameFor(result.source.sourceId)
                  : result.targets[0]
                    ? nameFor(result.targets[0].projectId)
                    : result.intentId}{" "}
                · {t("skillManagement.statusRecovery")}
              </button>
            ))}
          </section>
        ) : null}
      </div>
    </SheetFrame>
  );
}
