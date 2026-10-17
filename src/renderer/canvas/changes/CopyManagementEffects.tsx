import { LoadingSkeleton } from "../../components/ui/Skeleton";
import type { ReactElement } from "react";

import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { SkillLocationKey, SourceSkillRef } from "../../../domain/skill-reconciliation/types";
import type { SkillPreview } from "../../../shared/skill-management-ipc";
import { useI18n, tCount, type TranslationKey } from "../../i18n";
import { harnessLabel } from "../../operations/assignment-plan-view";
import { sourcePackagePath } from "../use-owned-skill-choices";
import { CopyFileEffects } from "./CopyFileEffects";
import type { CopyManagementAction } from "./copy-management-actions";
import { readySteps, filesFor } from "./operation-view-model";

function sourceSkillLabel(snapshot: ResourceSnapshot, source: SourceSkillRef): string {
  const sourceEntry = snapshot.registry.sources.find((entry) => entry.ref.id === source.sourceId);
  const evidence = snapshot.roots.find(
    (root) => root.entry.kind === "source" && root.entry.id === source.sourceId,
  )?.evidence;
  const pkg =
    evidence?.status === "observed"
      ? evidence.observation.inventory.packages?.find((entry) => entry.id === source.packageId)
      : undefined;
  const skill =
    evidence?.status === "observed" && pkg
      ? evidence.observation.inventory.artifacts.find(
          (artifact) =>
            artifact.kind === "skill" &&
            artifact.packageId === source.packageId &&
            sourcePackagePath(pkg.relativeRoot, artifact.relativePath) === source.artifactPath,
        )
      : undefined;
  const skillName = source.artifactPath.split("/").at(-1) ?? source.artifactPath;
  return `${sourceEntry?.displayName ?? source.sourceId} · ${pkg?.displayName ?? source.packageId} · ${skillName}`;
}

const actionTitle = {
  keep: "skillManagement.keepThisCopy",
  link: "skillManagement.manageWithOmni",
  canonical: "skillManagement.useMarketplaceVersion",
  capture: "skillManagement.copyToMarketplace",
  detach: "skillManagement.stopManagingCopy",
} as const satisfies Record<CopyManagementAction, TranslationKey>;

export function CopyManagementEffects(
  props: Readonly<{
    action: CopyManagementAction | "";
    target: SkillLocationKey;
    snapshot: ResourceSnapshot;
    projectName: string;
    source?: SourceSkillRef;
    destinationLabel?: string;
    preview: SkillPreview | null;
    error: string | null;
    busy: boolean;
    localNoWrite: boolean;
    restoreReview: boolean;
    reviewCurrent: boolean;
  }>,
): ReactElement {
  const { t, language } = useI18n();
  const steps = readySteps(props.preview);
  const files = filesFor(steps);
  const changedFiles = files.filter((file) => file.change !== "unchanged");
  const trackingKey: TranslationKey = props.restoreReview
    ? "skillManagement.restoreConsequence"
    : props.action === "keep"
      ? "skillManagement.keepCopyConsequence"
      : props.action === "link"
        ? "skillManagement.linkCopyConsequence"
        : props.action === "canonical"
          ? "skillManagement.canonicalCopyConsequence"
          : props.action === "capture"
            ? "skillManagement.captureCopyConsequence"
            : "skillManagement.detachCopyConsequence";

  return (
    <section className="copy-management-effects" data-testid="copy-management-effects">
      <h3>
        {t(
          props.restoreReview
            ? "skillManagement.restoreReview"
            : props.action
              ? actionTitle[props.action]
              : "skillManagement.chooseCopyAction",
        )}
      </h3>
      {props.error ? (
        <p className="changes-error" role="alert">
          {props.error}
        </p>
      ) : null}
      {props.busy ? <LoadingSkeleton label={t("skillManagement.loading")} variant="rows" /> : null}
      {!props.reviewCurrent ? (
        <p className="changes-error" role="alert">
          {t("skillManagement.copyChangedSinceReview")}
        </p>
      ) : null}
      {props.preview && props.preview.status !== "ready" ? (
        <div aria-live="polite" className="copy-management-preview-state" role="alert">
          <p>{props.preview.reason}</p>
          {props.preview.details.map((detail) => (
            <p key={`${detail.code}:${detail.message}`}>{detail.message}</p>
          ))}
        </div>
      ) : null}
      {props.localNoWrite ? <p>{t("skillManagement.noFileChanges")}</p> : null}
      <dl>
        <div>
          <dt>{t("skillManagement.selectedCopy")}</dt>
          <dd>
            {props.projectName} · {harnessLabel(props.target.harnessId, t)}
          </dd>
        </div>
        {props.source ? (
          <div>
            <dt>{t("skillManagement.marketplaceSkill")}</dt>
            <dd>{sourceSkillLabel(props.snapshot, props.source)}</dd>
          </div>
        ) : null}
        {props.destinationLabel ? (
          <div>
            <dt>{t("skillManagement.personalDestination")}</dt>
            <dd>{props.destinationLabel}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("skillManagement.trackingEffects")}</dt>
          <dd>{t(trackingKey)}</dd>
        </div>
        {props.preview?.status === "ready" ? (
          <div>
            <dt>{t("skillManagement.fileEffects")}</dt>
            <dd>
              {changedFiles.length === 0
                ? t("skillManagement.noFileChanges")
                : tCount("skillManagement.copyChangedFileCount", changedFiles.length, {}, language)}
            </dd>
          </div>
        ) : null}
      </dl>
      <CopyFileEffects files={changedFiles} projectId={props.target.projectId} />
      <details className="copy-management-details">
        <summary>{t("canvas.details")}</summary>
        <dl>
          <div>
            <dt>{t("skillManagement.selectedCopyPath")}</dt>
            <dd>
              <code>{props.target.folderPath}</code>
            </dd>
          </div>
          {props.preview?.status === "ready" ? (
            <>
              <div>
                <dt>{t("skillManagement.intentId")}</dt>
                <dd>
                  <code>{props.preview.intentId}</code>
                </dd>
              </div>
              <div>
                <dt>{t("skillManagement.effectFingerprint")}</dt>
                <dd>
                  <code>{props.preview.effectFingerprint}</code>
                </dd>
              </div>
            </>
          ) : null}
        </dl>
      </details>
    </section>
  );
}
