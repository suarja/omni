import { useEffect, useMemo, type ReactElement } from "react";
import { SheetFrame } from "./SheetFrame";

import {
  createResourceCatalogue,
  type ProjectSkillGroup,
  type ResourceRef,
  type ResourceSnapshot,
} from "../../domain/resource-catalogue";
import { useI18n } from "../i18n";

function groupType(group: ProjectSkillGroup, t: ReturnType<typeof useI18n>["t"]): string {
  if (group.category === "managed-plugin") return t("canvas.managedPlugin");
  if (group.category === "origin") return t("canvas.declaredSource");
  return t("canvas.groupIndividualSkills");
}

function verificationText(
  group: ProjectSkillGroup,
  location: ProjectSkillGroup["locations"][number],
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (location.origin?.verification === "matches-lock") return t("canvas.matchesRecordedInstallation");
  if (location.origin?.verification === "modified") return t("canvas.locallyModified");
  if (location.origin?.verification === "unverified") return t("canvas.notVerified");
  return group.category === "individual" ? t("canvas.noDeclaredOrigin") : t("canvas.managedRelationship");
}

function membershipIssueText(
  issue: NonNullable<ProjectSkillGroup["locations"][number]["membershipIssue"]>,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (issue === "ambiguous-assignment") return t("canvas.ambiguousAssignment");
  if (issue === "source-unavailable") return t("canvas.assignmentSourceUnavailable");
  return t("canvas.assignmentOriginDisagreement");
}

function verificationReason(
  location: ProjectSkillGroup["locations"][number],
  t: ReturnType<typeof useI18n>["t"],
): string | undefined {
  const reason = location.origin?.verificationReason;
  if (reason === "budget") return t("canvas.verificationBudget");
  if (reason === "unsafe-tree") return t("canvas.verificationUnsafeTree");
  if (reason === "unavailable") return t("canvas.verificationUnavailable");
  return undefined;
}

export function CanvasGroupSheet(
  props: Readonly<{
    group: ProjectSkillGroup;
    snapshot: ResourceSnapshot;
    onClose: () => void;
    onInspectSource: (ref: Extract<ResourceRef, { kind: "package" }>) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const catalogue = useMemo(() => createResourceCatalogue(props.snapshot), [props.snapshot]);
  const sourceDetails = props.group.sourcePackage ? catalogue.inspect(props.group.sourcePackage) : null;

  return (
    <SheetFrame
      title={props.group.label}
      label={t("canvas.groupInfo", { name: props.group.label })}
      kicker={groupType(props.group, t)}
      testId="canvas-group-sheet"
      resizeKind="details"
      onClose={props.onClose}
    >
      {props.group.source ? (
        <p>
          <span className="canvas-meta-label">{t("canvas.declaredSource")}</span>
          <code>{props.group.source.locator}</code>
        </p>
      ) : null}
      {props.group.sourcePackage ? (
        sourceDetails ? (
          <>
            <p>
              <span className="canvas-meta-label">{t("canvas.packageFormat")}</span>
              <code>{sourceDetails.packageFormat ?? t("canvas.metadataUnavailable")}</code>
            </p>
            <button
              className="canvas-secondary-button"
              data-testid="canvas-inspect-source"
              onClick={() => props.onInspectSource(props.group.sourcePackage!)}
              type="button"
            >
              {t("canvas.inspectSourcePlugin")}
            </button>
          </>
        ) : (
          <p className="canvas-error">{t("canvas.sourceUnavailable")}</p>
        )
      ) : null}
      <h3 className="canvas-location-heading">{t("canvas.groupLocations")}</h3>
      <ul className="canvas-file-list canvas-location-list">
        {props.group.locations.map((location) => (
          <li key={JSON.stringify([location.ref, location.relativePath])}>
            <code>{location.relativePath}</code>
            <p>
              {verificationText(props.group, location, t)}
              {verificationReason(location, t) ? ` · ${verificationReason(location, t)}` : ""}
            </p>
            {location.membershipIssue ? (
              <p className="canvas-error">{membershipIssueText(location.membershipIssue, t)}</p>
            ) : null}
            {location.origin ? (
              <>
                <p>
                  <span className="canvas-meta-label">{t("canvas.evidenceFile")}</span>{" "}
                  <code>{location.origin.lockPath}</code>
                </p>
                {location.origin.sourceSkillPath ? (
                  <p>
                    <span className="canvas-meta-label">{t("canvas.upstreamSkillPath")}</span>{" "}
                    <code>{location.origin.sourceSkillPath}</code>
                  </p>
                ) : null}
                {location.origin.reference ? (
                  <p>
                    <span className="canvas-meta-label">{t("canvas.upstreamReference")}</span>{" "}
                    <code>{location.origin.reference}</code>
                  </p>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </SheetFrame>
  );
}
