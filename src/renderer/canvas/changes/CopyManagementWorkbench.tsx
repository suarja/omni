import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { ManagedSkillUse, SkillLocationKey } from "../../../domain/skill-reconciliation/types";
import type { EntryRef, Observation } from "../../../domain/project-source-registry";
import type { DesktopApi } from "../../../shared/ipc";
import type { SkillResult } from "../../../shared/skill-management-ipc";
import type { LogicalSkillNode } from "../spatial/spatial-types";
import { useI18n, type TranslationKey } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { CanvasSelect } from "../CanvasSelect";
import { CopyComparisonContent } from "./CopyComparisonContent";
import { CopyManagementDecision } from "./CopyManagementDecision";
import { CopyManagementEffects } from "./CopyManagementEffects";
import { CopyManagementResult } from "./CopyManagementResult";
import { useCopyManagement } from "./use-copy-management";
import { copyLocationKey, copyLocationOptions } from "./copy-management-view-model";
import { canReviewRestore } from "./operation-view-model";
import type { SkillCopyComparisonState } from "./use-skill-copy-comparison";
import "./changes.css";
import "./copy-management.css";

type CopyManagementApi = Pick<
  DesktopApi,
  | "compareSkillCopies"
  | "previewSkillOperation"
  | "refreshSkillOperation"
  | "applySkillOperation"
  | "readSkillOperationResult"
> &
  Partial<Pick<DesktopApi, "onReviewChanged">>;
type ComparisonUnavailableReason = Extract<SkillCopyComparisonState, { status: "unavailable" }>["reason"];

const comparisonUnavailableKeys = {
  grant: "skillManagement.comparisonUnavailableGrant",
  root: "skillManagement.comparisonUnavailableRoot",
  store: "skillManagement.comparisonUnavailableStore",
  membership: "skillManagement.comparisonUnavailableMembership",
  read: "skillManagement.comparisonUnavailableRead",
} as const satisfies Record<ComparisonUnavailableReason, TranslationKey>;

export function CopyManagementWorkbench(
  props: Readonly<{
    api: CopyManagementApi | null;
    snapshot: ResourceSnapshot;
    node: LogicalSkillNode;
    managedUses: readonly ManagedSkillUse[];
    managedUsesStatus: "ready" | "loading" | "unavailable";
    initialTarget: SkillLocationKey;
    workflowKey: string;
    initialResult?: SkillResult;
    initialRestoreReview?: boolean;
    hasReader: boolean;
    onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
    onObserveSource?: (sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>;
    onRefresh: () => void | Promise<void>;
    onBack: () => void;
    onClose: () => void;
    onApplyingChange?: (applying: boolean) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const management = useCopyManagement({
    api: props.api,
    snapshot: props.snapshot,
    node: props.node,
    managedUses: props.managedUses,
    managedUsesStatus: props.managedUsesStatus,
    initialTarget: props.initialTarget,
    workflowKey: props.workflowKey,
    onEnsureGrant: props.onEnsureGrant,
    onObserveSource: props.onObserveSource,
    onRefresh: props.onRefresh,
    initialResult: props.initialResult,
    initialRestoreReview: props.initialRestoreReview,
  });
  const { operation, comparison } = management;
  const projectName =
    props.snapshot.registry.projects.find((project) => project.ref.id === management.target.projectId)?.displayName ??
    management.target.projectId;
  const options = useMemo(
    () =>
      copyLocationOptions(
        props.node.locations.map(({ location }) => location),
        t,
      ),
    [props.node.locations, t],
  );
  const targetOptions = options;
  const referenceOptions = options.map((option) => ({
    ...option,
    disabled: option.value === copyLocationKey(management.target),
  }));
  const member = props.node.members.find(
    (candidate) => copyLocationKey(candidate.location) === copyLocationKey(management.target),
  );
  const targetReadable = member?.read.status === "complete";
  const hasMultipleCopies = props.node.locations.length > 1;
  const comparisonUnavailableKey =
    comparison.state.status === "unavailable" ? comparisonUnavailableKeys[comparison.state.reason] : undefined;
  const result = management.result;
  const canRestore = Boolean(result && result.status !== "restored" && canReviewRestore(result));
  const currentIntent = management.restoreReview
    ? { kind: "restore", operationId: result?.operationId ?? "" }
    : management.decision.kind === "operation"
      ? management.decision.intent
      : null;
  const readyToApply = Boolean(
    management.stage === "effects" &&
    !operation.busy &&
    !operation.applying &&
    management.reviewCurrent &&
    (management.localNoWrite
      ? management.decision.kind === "local-no-write"
      : operation.preview?.status === "ready" &&
        currentIntent !== null &&
        JSON.stringify(operation.intent) === JSON.stringify(currentIntent)),
  );
  const tabNames = ["compare", "effects", "result"] as const;

  useEffect(() => closeButton.current?.focus(), []);
  useEffect(() => {
    props.onApplyingChange?.(operation.applying);
    return () => props.onApplyingChange?.(false);
  }, [operation.applying, props.onApplyingChange]);

  const handleTabs = (event: KeyboardEvent<HTMLElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[index]?.click();
    buttons[index]?.focus();
  };

  const selectTab = (tab: (typeof tabNames)[number]): void => {
    if (tab === "compare") management.backToCompare();
    else if (tab === "result") management.showResult();
  };

  return (
    <SheetFrame
      title={props.node.label}
      label={t("skillManagement.copyManagementTitle", { name: props.node.label })}
      kicker={projectName}
      className="changes-workbench copy-management-workbench"
      testId="copy-management-workbench"
      modal
      busy={operation.applying}
      onClose={props.onClose}
      closeRef={closeButton}
      closeLabel={t("skillManagement.closeCopyManagement")}
      resizeKind="changes"
      headerClassName="changes-header"
      tabs={
        <nav
          aria-label={t("skillManagement.copyManagementTitle", { name: props.node.label })}
          className="changes-tabs"
          onKeyDown={handleTabs}
          role="tablist"
        >
          {tabNames.map((tab) => {
            const active = management.stage === tab;
            const disabled =
              operation.applying ||
              (tab === "effects" && management.stage !== "effects") ||
              (tab === "result" && !result && !management.localNoWriteResult);
            return (
              <button
                aria-controls={`copy-management-panel-${tab}`}
                aria-selected={active}
                disabled={disabled}
                id={`copy-management-tab-${tab}`}
                key={tab}
                onClick={() => selectTab(tab)}
                role="tab"
                tabIndex={active ? 0 : -1}
                type="button"
              >
                {t(`skillManagement.copyManagementTab.${tab}`)}
              </button>
            );
          })}
        </nav>
      }
      footer={
        <div className="copy-management-footer">
          {management.stage === "compare" ? (
            <>
              <CopyManagementDecision
                action={management.action}
                actions={management.actions}
                busy={operation.busy || operation.applying}
                destinationValue={management.destinationValue}
                destinations={management.destinations}
                onActionChange={management.setAction}
                onDestinationChange={management.selectDestination}
                onRetrySource={management.retrySource}
                onSkillKeyChange={management.setSkillKey}
                onSourceChange={management.selectSource}
                skillKey={management.skillKey}
                sourceOptions={management.sourceChoices.options}
                sourceStatus={management.sourceChoices.status}
                sourceValue={management.sourceChoices.selectedValue}
                targetReadable={Boolean(targetReadable)}
              />
              <div className="copy-management-footer-actions">
                <button
                  className="changes-secondary"
                  disabled={operation.applying}
                  onClick={props.hasReader ? props.onBack : props.onClose}
                  type="button"
                >
                  {props.hasReader ? t("skillManagement.backToCopies") : t("skillManagement.closeCopyManagement")}
                </button>
                <button
                  className="changes-primary"
                  disabled={management.decision.kind === "unavailable" || operation.busy || operation.applying}
                  onClick={management.reviewEffects}
                  type="button"
                >
                  {t("skillManagement.reviewEffects")}
                </button>
              </div>
            </>
          ) : null}
          {management.stage === "effects" ? (
            <div className="copy-management-footer-actions">
              {management.restoreReview ? (
                <button
                  className="changes-secondary"
                  disabled={operation.applying}
                  onClick={management.cancelRestore}
                  type="button"
                >
                  {t("skillManagement.cancelRestore")}
                </button>
              ) : (
                <button
                  className="changes-secondary"
                  disabled={operation.applying}
                  onClick={management.backToCompare}
                  type="button"
                >
                  {t("skillManagement.backToCompare")}
                </button>
              )}
              {!management.localNoWrite && operation.preview ? (
                <button
                  className="changes-secondary"
                  disabled={operation.busy || operation.applying}
                  onClick={() => void management.refreshPreview()}
                  type="button"
                >
                  {t("skillManagement.refreshPreview")}
                </button>
              ) : null}
              <button
                className="changes-primary"
                disabled={!readyToApply}
                onClick={() => void management.apply()}
                type="button"
              >
                {management.localNoWrite
                  ? t("skillManagement.keepThisCopy")
                  : management.restoreReview
                    ? t("skillManagement.restoreOperation")
                    : t("skillManagement.applyToCopy")}
              </button>
            </div>
          ) : null}
          {management.stage === "result" ? (
            <div className="copy-management-footer-actions">
              {props.hasReader ? (
                <button className="changes-primary" onClick={props.onBack} type="button">
                  {t("skillManagement.backToCopies")}
                </button>
              ) : null}
              {canRestore ? (
                <button className="changes-secondary" onClick={management.reviewRestore} type="button">
                  {t("skillManagement.restoreReview")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    >
      <div
        aria-labelledby={`copy-management-tab-${management.stage}`}
        className={`changes-body copy-management-body is-${management.stage}`}
        data-testid={`copy-management-panel-${management.stage}`}
        id={`copy-management-panel-${management.stage}`}
        role="tabpanel"
        tabIndex={0}
      >
        {management.stage === "compare" ? (
          <>
            <div className="copy-management-selectors">
              <CanvasSelect
                disabled={!hasMultipleCopies}
                label={t("skillManagement.compareWith")}
                onChange={(value) => {
                  const next = props.node.locations.find(
                    ({ location }) => copyLocationKey(location) === value,
                  )?.location;
                  if (next) management.selectReference(next);
                }}
                options={referenceOptions}
                placeholder={hasMultipleCopies ? undefined : t("skillManagement.noComparisonPeer")}
                value={management.reference ? copyLocationKey(management.reference) : ""}
              />
              <CanvasSelect
                label={t("skillManagement.copyToManage")}
                onChange={(value) => {
                  const next = props.node.locations.find(
                    ({ location }) => copyLocationKey(location) === value,
                  )?.location;
                  if (next) management.selectTarget(next);
                }}
                options={targetOptions}
                value={copyLocationKey(management.target)}
              />
            </div>
            {!hasMultipleCopies ? <p className="copy-management-single">{t("skillManagement.singleCopy")}</p> : null}
            {!targetReadable ? (
              <div className="copy-management-unavailable" role="alert">
                <p>{t("skillManagement.selectedCopyUnavailable")}</p>
                <button
                  className="changes-secondary"
                  onClick={() => void management.refreshObservation()}
                  type="button"
                >
                  {t("skillManagement.retryComparison")}
                </button>
              </div>
            ) : null}
            {targetReadable && hasMultipleCopies && comparison.state.status === "loading" ? (
              <p aria-live="polite">{t("skillManagement.comparisonLoading")}</p>
            ) : null}
            {targetReadable && hasMultipleCopies && comparisonUnavailableKey ? (
              <div className="copy-management-unavailable" role="alert">
                <p>{t(comparisonUnavailableKey)}</p>
                <button
                  className="changes-secondary"
                  onClick={() => void management.refreshObservation()}
                  type="button"
                >
                  {t("skillManagement.retryComparison")}
                </button>
              </div>
            ) : null}
            {targetReadable && hasMultipleCopies && comparison.state.status === "ready" ? (
              <CopyComparisonContent
                fileScope="changes"
                copyALabel={t("skillManagement.compareWith")}
                copyBLabel={t("skillManagement.copyToManage")}
                layout={layout}
                onLayoutChange={setLayout}
                onSelectFile={comparison.selectFile}
                response={comparison.state.response}
                selectedPath={comparison.state.selectedPath}
              />
            ) : null}
            {management.policyError || (management.action && management.decision.kind === "unavailable") ? (
              <p className="changes-error" role="alert">
                {management.policyError ??
                  (management.decision.kind === "unavailable" ? management.decision.reason : null)}
              </p>
            ) : null}
          </>
        ) : null}
        {management.stage === "effects" ? (
          <CopyManagementEffects
            action={management.action}
            busy={operation.busy}
            destinationLabel={management.destinationLabel}
            error={operation.error}
            localNoWrite={management.localNoWrite}
            preview={operation.preview}
            projectName={projectName}
            restoreReview={management.restoreReview}
            reviewCurrent={management.reviewCurrent}
            snapshot={props.snapshot}
            source={
              management.action === "link"
                ? management.sourceChoices.selected?.source
                : props.managedUses.find((use) => copyLocationKey(use.location) === copyLocationKey(management.target))
                    ?.source
            }
            target={management.target}
          />
        ) : null}
        {management.stage === "result" ? (
          <CopyManagementResult
            localNoWrite={management.localNoWriteResult}
            result={result}
            snapshot={props.snapshot}
            target={management.target}
          />
        ) : null}
      </div>
    </SheetFrame>
  );
}
