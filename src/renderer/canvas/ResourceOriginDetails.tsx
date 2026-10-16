import type { ReactElement } from "react";

import type { ResourceDetails } from "../../domain/resource-catalogue";
import { useI18n } from "../i18n";

function verificationLabel(
  status: NonNullable<ResourceDetails["skillOrigins"]>[number]["verification"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (status === "matches-lock") return t("canvas.matchesRecordedInstallation");
  if (status === "modified") return t("canvas.locallyModified");
  return t("canvas.notVerified");
}

function verificationReason(
  reason: NonNullable<ResourceDetails["skillOrigins"]>[number]["verificationReason"],
  t: ReturnType<typeof useI18n>["t"],
): string | undefined {
  if (!reason) return undefined;
  if (reason === "budget") return t("canvas.verificationBudget");
  if (reason === "unsafe-tree") return t("canvas.verificationUnsafeTree");
  return t("canvas.verificationUnavailable");
}

function issueLabel(
  issue: NonNullable<ResourceDetails["membershipIssues"]>[number]["reason"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (issue === "ambiguous-assignment") return t("canvas.ambiguousAssignment");
  if (issue === "source-unavailable") return t("canvas.assignmentSourceUnavailable");
  return t("canvas.assignmentOriginDisagreement");
}

export function ResourceOriginDetails(
  props: Readonly<{
    details: ResourceDetails;
    displayedPath?: string;
  }>,
): ReactElement | null {
  const { t } = useI18n();
  if (!props.displayedPath) return null;
  const origin = props.details.skillOrigins?.find((item) => item.relativePath === props.displayedPath);
  const membershipIssue = props.details.membershipIssues?.find((item) => item.relativePath === props.displayedPath);
  if (!origin && !membershipIssue) return null;

  return (
    <section
      aria-label={t("canvas.locationProvenance")}
      className="canvas-use-section"
      data-testid="resource-origin-details"
    >
      <h3>{t("canvas.locationProvenance")}</h3>
      {origin ? (
        <>
          <p>
            <span className="canvas-meta-label">{t("canvas.declaredSource")}</span>
            <code>{origin.source.locator}</code>
          </p>
          <p>
            <span className="canvas-meta-label">{t("canvas.evidenceFile")}</span>
            <code>{origin.lockPath}</code>
          </p>
          {origin.sourceSkillPath ? (
            <p>
              <span className="canvas-meta-label">{t("canvas.upstreamSkillPath")}</span>
              <code>{origin.sourceSkillPath}</code>
            </p>
          ) : null}
          {origin.reference ? (
            <p>
              <span className="canvas-meta-label">{t("canvas.upstreamReference")}</span>
              <code>{origin.reference}</code>
            </p>
          ) : null}
          <p>
            {verificationLabel(origin.verification, t)}
            {verificationReason(origin.verificationReason, t)
              ? ` · ${verificationReason(origin.verificationReason, t)}`
              : ""}
          </p>
        </>
      ) : null}
      {membershipIssue ? <p className="canvas-error">{issueLabel(membershipIssue.reason, t)}</p> : null}
    </section>
  );
}
