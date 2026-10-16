import type { ReactElement } from "react";
import type { SkillResult } from "../../../../shared/skill-management-ipc";
import type { SkillPropagationSummary, SkillPropagationTarget } from "../../../../shared/skill-propagation-ipc";
import type { TranslationFunction } from "../../../i18n";
import { Icon } from "../../../components/Icon";
import { canReviewRestore, resultLabel } from "../operation-view-model";
import { buildPropagationView } from "./view-model";
import { harnessName, outcomeKeys, toneIcons } from "./labels";

export function PropagationResult({
  result,
  summary,
  view,
  originals = [],
  t,
  nameFor,
  onRetry,
  onRestore,
  onOpenOriginal,
}: Readonly<{
  result: SkillResult;
  summary: SkillPropagationSummary;
  view?: ReturnType<typeof buildPropagationView>;
  originals?: readonly SkillResult[];
  t: TranslationFunction;
  nameFor: (id: string) => string;
  onRetry?: (target: SkillPropagationTarget) => void;
  onRestore?: (id: string) => void;
  onOpenOriginal?: (id: string) => void;
}>): ReactElement {
  const model = view ?? buildPropagationView(summary, [], undefined, result);
  const statuses = {
    applied: "statusApplied",
    "no-op": "statusNoOp",
    partial: "statusPartial",
    failed: "statusFailed",
    cancelled: "statusFailed",
    recovery: "statusRecovery",
    restored: "statusRestored",
    applying: "statusApplying",
  } as const;
  const sourceKeys = {
    updated: "sourceUpdated",
    created: "sourceCreated",
    unchanged: "propagationSourceCurrent",
    failed: "failed",
    restored: "restored",
    unknown: "outcomeUnknown",
  } as const;
  return (
    <section className="propagation-result" data-testid="changes-result" aria-live="polite">
      <h3>{t(`skillManagement.${statuses[resultLabel(result)]}`)}</h3>
      <p className="changes-note">{t(`skillManagement.${sourceKeys[result.source.status]}`)}</p>
      <p className="changes-note">
        {t("skillManagement.propagationCounts", { projects: model.projectCount, copies: model.copyCount })}
      </p>
      {model.locations.map((item) => (
        <article className="propagation-project-row" key={item.key} data-tone={item.tone} data-outcome={item.outcome}>
          <Icon name={toneIcons[item.tone]} />
          <span className="propagation-project-name">
            {nameFor(item.target.location.projectId)}
            <small>{harnessName(item.target.location.harnessId)}</small>
            {item.target.reason ? <small>{item.target.reason}</small> : null}
            <details className="propagation-details">
              <summary>{t("canvas.details")}</summary>
              <code>{item.target.location.folderPath}</code>
            </details>
          </span>
          <span className="propagation-project-status">{t(outcomeKeys[item.outcome])}</span>
          {item.retryable && onRetry ? (
            <button
              className="changes-secondary"
              data-testid="changes-propagation-retry"
              type="button"
              onClick={() => onRetry(item.target)}
            >
              {t("skillManagement.propagationRetry")}
            </button>
          ) : null}
        </article>
      ))}
      <details className="propagation-details">
        <summary>{t("skillManagement.propagationOperationDetails")}</summary>
        <p>
          {t("skillManagement.operationId")}: <code>{result.operationId}</code>
        </p>
        <p>{t("skillManagement.sourceReceipt")}</p>
        <ul>
          {result.receiptIds.map((id) => (
            <li key={id}>
              <code>{id}</code>
            </li>
          ))}
        </ul>
        {result.propagation?.retryOf ? (
          <p>
            {t("skillManagement.propagationRetryOf")}: <code>{result.propagation.retryOf}</code>
          </p>
        ) : null}
        {originals
          .filter((item) => item.intentId !== result.intentId)
          .map((original) => (
            <button
              className="changes-secondary"
              type="button"
              key={original.intentId}
              onClick={() => onOpenOriginal?.(original.intentId)}
            >
              {t(
                original.propagation?.retryOf === result.intentId
                  ? "skillManagement.propagationOpenRetry"
                  : "skillManagement.propagationOpenOriginal",
              )}
            </button>
          ))}
        {result.propagation?.retryOf &&
        !originals.some((item) => item.intentId === result.propagation?.retryOf) &&
        onOpenOriginal ? (
          <button
            className="changes-secondary"
            type="button"
            onClick={() => onOpenOriginal(result.propagation!.retryOf!)}
          >
            {t("skillManagement.propagationOpenOriginal")}
          </button>
        ) : null}
      </details>
      {result.issues.map((issue) => (
        <p key={`${issue.code}:${issue.message}`} className="changes-issue">
          {issue.message}
        </p>
      ))}
      {result.recoveryAvailable ? <p className="changes-recovery">{t("skillManagement.recovery")}</p> : null}
      {result.status !== "restored" && canReviewRestore(result) && onRestore ? (
        <button className="changes-secondary" type="button" onClick={() => onRestore(result.operationId)}>
          {t("skillManagement.restoreReview")}
        </button>
      ) : null}
    </section>
  );
}
