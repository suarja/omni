import { useState, type ReactElement } from "react";

import type { SkillResult } from "../../../shared/skill-management-ipc";
import type { TranslationFunction } from "../../i18n";
import type { SourceSkillRef } from "../../../domain/skill-reconciliation/types";
import type { SkillPropagationTarget } from "../../../shared/skill-propagation-ipc";
import { canReviewRestore, resultLabel } from "./operation-view-model";
import { PropagationResult } from "./propagation/PropagationResult";

export function ChangesResult({
  result,
  onRestore,
  t,
  nameFor = (id) => id,
  onOpenVariant,
  showRestoreAction = true,
  onRetryPropagation,
}: Readonly<{
  result: SkillResult;
  onRestore: (operationId: string) => void;
  t: TranslationFunction;
  nameFor?: (id: string) => string;
  onOpenVariant?: (source: SourceSkillRef) => void | Promise<void>;
  showRestoreAction?: boolean;
  onRetryPropagation?: (target: SkillPropagationTarget) => void;
}>): ReactElement {
  const [variantError, setVariantError] = useState<string | null>(null);
  const [openingVariant, setOpeningVariant] = useState(false);
  if (result.propagation)
    return (
      <PropagationResult
        result={result}
        summary={result.propagation}
        nameFor={nameFor}
        t={t}
        onRetry={onRetryPropagation}
        onRestore={showRestoreAction ? onRestore : undefined}
      />
    );
  const labelKey = {
    applied: "statusApplied",
    "no-op": "statusNoOp",
    partial: "statusPartial",
    failed: "statusFailed",
    cancelled: "statusFailed",
    recovery: "statusRecovery",
    restored: "statusRestored",
    applying: "statusApplying",
  } as const;
  const sourceMessage =
    result.link && result.source.status === "unchanged"
      ? t("skillManagement.canonicalSourceUnchanged")
      : result.source.status === "created"
        ? t("skillManagement.sourceCreated")
        : result.source.status === "updated"
          ? t("skillManagement.sourceUpdated")
          : result.source.status === "restored"
            ? t("skillManagement.restored")
            : result.source.status === "unchanged"
              ? t("skillManagement.unchanged")
              : result.source.status === "unknown"
                ? t("skillManagement.outcomeUnknown")
                : t("skillManagement.failed");
  const hasRestore = result.status !== "restored" && canReviewRestore(result);
  const targetStatusKey = {
    applied: "outcomeApplied",
    removed: "outcomeRemoved",
    "no-op": "outcomeNoOp",
    "retained-local": "outcomeRetained",
    skipped: "outcomeSkipped",
    failed: "outcomeFailed",
    cancelled: "outcomeSkipped",
    restored: "outcomeRestored",
    unknown: "outcomeUnknown",
    pending: "outcomePending",
  } as const;
  return (
    <section aria-live="polite" className={`changes-result is-${resultLabel(result)}`} data-testid="changes-result">
      <header>
        <small>{t("skillManagement.result")}</small>
        <strong>
          {t(
            result.status === "applied" && result.resolution?.choice === "keep-local"
              ? "skillManagement.localContentRetained"
              : `skillManagement.${labelKey[resultLabel(result)]}`,
          )}
        </strong>
      </header>
      <p>{sourceMessage}</p>
      {result.resolution?.choice === "adopt-exact" && !result.link ? (
        <section aria-label={t("skillManagement.adoptionEffects")} className="changes-result-adoption">
          <h3>{t("skillManagement.adoptionEffects")}</h3>
          <p>{t("skillManagement.adoptionNoFileChanges")}</p>
          <p>
            {t("skillManagement.operationId")}: <code>{result.operationId}</code>
          </p>
          <ul>
            {result.resolution.targets.map((target) => (
              <li key={target.bindingId}>
                <span>
                  {nameFor(target.location.projectId)} · {target.location.harnessId} · {target.location.folderPath}
                </span>
                <code>{target.bindingId}</code>
              </li>
            ))}
          </ul>
          <p>{t("skillManagement.otherCopiesRemainUnchanged")}</p>
        </section>
      ) : null}
      {result.resolution && result.resolution.choice !== "adopt-exact" ? (
        <section aria-label={t("skillManagement.resolutionReview")} className="changes-result-resolution">
          <h3>
            {t(
              result.resolution.choice === "keep-local" ? "skillManagement.keepLocal" : "skillManagement.useCanonical",
            )}
          </h3>
          {result.resolution.targets.map((target) => (
            <p key={target.bindingId}>
              {nameFor(target.location.projectId)} · {target.location.harnessId} ·{" "}
              <code>{target.location.folderPath}</code>
              <strong>{t(`skillManagement.${targetStatusKey[target.status]}`)}</strong>
            </p>
          ))}
          {result.resolution.choice === "keep-local" &&
          result.resolution.targets.some((target) => target.status === "retained-local") ? (
            <p>{t("skillManagement.localContentRetained")}</p>
          ) : null}
          <p className="changes-note">{t("skillManagement.otherCopiesRemainUnchanged")}</p>
        </section>
      ) : null}
      {result.detachment ? (
        <section
          aria-label={t("skillManagement.detachmentEffects")}
          className="changes-result-adoption changes-result-detachment"
        >
          <h3>
            {t(
              result.detachment.status === "detached"
                ? "skillManagement.detachmentStopped"
                : result.detachment.status === "restored"
                  ? "skillManagement.detachmentRestored"
                  : result.detachment.status === "unchanged"
                    ? "skillManagement.detachmentUnchanged"
                    : result.detachment.status === "failed"
                      ? "skillManagement.detachmentFailed"
                      : "skillManagement.detachmentUnknown",
            )}
          </h3>
          <p>{t("skillManagement.detachmentNoFileChanges")}</p>
          <p>
            {nameFor(result.detachment.location.projectId)} · {result.detachment.location.harnessId} ·{" "}
            <code>{result.detachment.location.folderPath}</code>
          </p>
          <p>{t("skillManagement.detachmentBaseRetained")}</p>
          <p>{t("skillManagement.detachmentPeersRetained")}</p>
          <details>
            <summary>{t("canvas.details")}</summary>
            <dl>
              <div>
                <dt>{t("skillManagement.skillId")}</dt>
                <dd>
                  <code>{result.detachment.skillId}</code>
                </dd>
              </div>
              <div>
                <dt>{t("skillManagement.sourceId")}</dt>
                <dd>
                  <code>{result.detachment.source.sourceId}</code>
                </dd>
              </div>
              <div>
                <dt>{t("skillManagement.assignmentBinding")}</dt>
                <dd>
                  <code>{result.detachment.bindingId}</code>
                </dd>
              </div>
              <div>
                <dt>{t("skillManagement.detachmentPackage")}</dt>
                <dd>
                  {result.detachment.source.packageId} / {result.detachment.source.artifactPath}
                </dd>
              </div>
            </dl>
          </details>
        </section>
      ) : null}
      {result.link ? (
        <section aria-label={t("skillManagement.canonicalLinkEffects")} className="changes-result-unbound">
          {result.resolution?.choice === "adopt-exact" ? <p>{t("skillManagement.adoptionNoFileChanges")}</p> : null}
          <h3>
            {t(
              result.link.status === "applied"
                ? "skillManagement.canonicalLinked"
                : result.link.status === "restored"
                  ? "skillManagement.linkRestored"
                  : result.link.status === "failed"
                    ? "skillManagement.statusFailed"
                    : "skillManagement.outcomeUnknown",
            )}
          </h3>
          <p>
            {t("skillManagement.canonicalSource")}: {nameFor(result.link.source.sourceId)} ·{" "}
            {result.link.source.packageId} / <code>{result.link.source.artifactPath}</code>
          </p>
          <p>
            {t("skillManagement.selectedCopy")}: {nameFor(result.link.location.projectId)} ·{" "}
            {result.link.location.harnessId} · <code>{result.link.location.folderPath}</code>
          </p>
          <p>
            {t("skillManagement.historicalCommonBase")}: {t("skillManagement.historicalBaseUnknown")}
          </p>
          <details>
            <summary>{t("canvas.details")}</summary>
            <dl>
              <div>
                <dt>{t("skillManagement.skillId")}</dt>
                <dd>
                  <code>{result.link.skillId}</code>
                </dd>
              </div>
              <div>
                <dt>{t("skillManagement.sourceId")}</dt>
                <dd>
                  <code>{result.link.source.sourceId}</code>
                </dd>
              </div>
              <div>
                <dt>{t("skillManagement.assignmentBinding")}</dt>
                <dd>
                  <code>{result.link.bindingId}</code>
                </dd>
              </div>
            </dl>
          </details>
        </section>
      ) : null}
      {result.capture ? (
        <section aria-label={t("skillManagement.captureEffects")} className="changes-result-variant">
          <h3>{t("skillManagement.captureEffects")}</h3>
          <p>
            {t("skillManagement.variantDestination")}:{" "}
            <code>
              {result.capture.destination.packageId}/{result.capture.destination.artifactPath}
            </code>
          </p>
          <details>
            <summary>{t("skillManagement.variantOrigin")}</summary>
            <p>
              {t("skillManagement.variantId")}: <code>{result.capture.variantId}</code>
            </p>
            <p>
              {t("skillManagement.forkOf")}: <code>{result.capture.skillId}</code>
            </p>
            <p>
              {nameFor(result.capture.location.projectId)} · {result.capture.location.harnessId} ·{" "}
              <code>{result.capture.location.folderPath}</code>
            </p>
          </details>
          {result.capture.status === "applied" && onOpenVariant ? (
            <button
              className="changes-secondary"
              disabled={openingVariant}
              onClick={() => {
                setVariantError(null);
                setOpeningVariant(true);
                void Promise.resolve()
                  .then(() => onOpenVariant(result.capture!.destination))
                  .catch(() => setVariantError(t("skillManagement.variantOriginUnavailable")))
                  .finally(() => setOpeningVariant(false));
              }}
              type="button"
            >
              {t("skillManagement.openVariant")}
            </button>
          ) : null}
          {variantError ? (
            <p role="alert" className="changes-error">
              {variantError}
            </p>
          ) : null}
        </section>
      ) : null}
      {!result.propagation && result.targets.length ? (
        <section aria-label={t("skillManagement.targetOutcomes")} className="changes-target-results">
          <h3>{t("skillManagement.targetOutcomes")}</h3>
          <ul>
            {result.targets.map((target) => (
              <li key={`${target.projectId}:${target.harnessId}:${target.bindingId}`}>
                <span>
                  {nameFor(target.projectId)} · {target.harnessId} · {target.artifactPath}
                </span>
                <strong>
                  {t(
                    result.link?.status === "applied" && target.status === "applied"
                      ? "skillManagement.linkTargetApplied"
                      : `skillManagement.${targetStatusKey[target.status]}`,
                  )}
                </strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.receiptIds.length ? (
        <details className="changes-receipts">
          <summary>{t("skillManagement.sourceReceipt")}</summary>
          <p>
            <code>{result.operationId}</code>
          </p>
          <ul>
            {result.receiptIds.map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {result.issues.map((issue) => (
        <p className="changes-issue" key={`${issue.code}:${issue.message}`}>
          {issue.message}
        </p>
      ))}
      {result.recoveryAvailable && result.status !== "applied" && result.status !== "restored" ? (
        <p className="changes-recovery">{t("skillManagement.recovery")}</p>
      ) : null}
      {showRestoreAction && hasRestore ? (
        <button className="changes-secondary" onClick={() => onRestore(result.operationId)} type="button">
          {t("skillManagement.restoreReview")}
        </button>
      ) : null}
    </section>
  );
}
