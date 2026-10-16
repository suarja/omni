import { harnessLabel } from "./project-view-model";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { EntryRef, Observation } from "../../domain/project-source-registry";
import {
  createResourceCatalogue,
  type ProjectSkillGroup,
  type ResourceSnapshot,
} from "../../domain/resource-catalogue";
import type { LogicalSkillNode } from "./spatial/spatial-types";
import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";
import type { DesktopApi } from "../../shared/ipc";
import { AssetContent } from "../assets/AssetContent";
import { useI18n } from "../i18n";
import { SheetFrame } from "./SheetFrame";
import { useResourceDocument } from "./use-resource-document";
import "./skill-copies.css";

type SheetTab = "document" | "metadata" | "files";

function memberKey(member: LogicalSkillNode["members"][number]): string {
  return JSON.stringify([member.ref, member.location]);
}

function verificationText(
  group: ProjectSkillGroup,
  location: ProjectSkillGroup["locations"][number] | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (location?.origin?.verification === "matches-lock") return t("canvas.matchesRecordedInstallation");
  if (location?.origin?.verification === "modified") return t("canvas.locallyModified");
  if (location?.origin?.verification === "unverified") return t("canvas.notVerified");
  return location && group.category === "managed-plugin"
    ? t("canvas.managedRelationship")
    : t("canvas.noDeclaredOrigin");
}

function verificationReason(
  location: ProjectSkillGroup["locations"][number] | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string | undefined {
  const reason = location?.origin?.verificationReason;
  if (reason === "budget") return t("canvas.verificationBudget");
  if (reason === "unsafe-tree") return t("canvas.verificationUnsafeTree");
  if (reason === "unavailable") return t("canvas.verificationUnavailable");
  return undefined;
}

function membershipIssueText(
  issue: NonNullable<ProjectSkillGroup["locations"][number]["membershipIssue"]>,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (issue === "ambiguous-assignment") return t("canvas.ambiguousAssignment");
  if (issue === "source-unavailable") return t("canvas.assignmentSourceUnavailable");
  return t("canvas.assignmentOriginDisagreement");
}

export function SkillCopiesSheet(
  props: Readonly<{
    node: LogicalSkillNode;
    group: ProjectSkillGroup;
    snapshot: ResourceSnapshot;
    api: (Pick<DesktopApi, "readArtifact"> & Partial<Pick<DesktopApi, "readSkillVariantOrigin">>) | null;
    onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
    onCompare?: (initialLeft: SkillLocationKey, opener: HTMLButtonElement) => void;
    onClose: () => void;
    inert?: boolean;
    initialTab: "document" | "metadata";
    initialMember?: Readonly<{ ref: LogicalSkillNode["members"][number]["ref"]; relativePath: string }>;
  }>,
): ReactElement {
  const { t } = useI18n();
  const catalogue = useMemo(() => createResourceCatalogue(props.snapshot), [props.snapshot]);
  const [tab, setTab] = useState<SheetTab>(props.node.members.length ? props.initialTab : "metadata");
  const initialMember = props.initialMember
    ? props.node.members.find(
        (member) =>
          JSON.stringify(member.ref) === JSON.stringify(props.initialMember!.ref) &&
          `${member.location.folderPath}/SKILL.md` === props.initialMember!.relativePath,
      )
    : undefined;
  const [selectedKey, setSelectedKey] = useState(() => {
    const member = initialMember ?? props.node.members[0];
    return member ? memberKey(member) : "";
  });
  const selected = props.node.members.find((member) => memberKey(member) === selectedKey) ?? props.node.members[0];
  const knownLocations = [
    ...new Map(props.node.locations.map((copy) => [JSON.stringify(copy.location), copy.location])).values(),
  ];
  const initialLeft = selected?.location ?? knownLocations[0];
  const details = selected ? catalogue.inspect(selected.ref) : null;
  const sourceDetails = props.group.sourcePackage ? catalogue.inspect(props.group.sourcePackage) : null;
  const skillPath = selected ? `${selected.location.folderPath}/SKILL.md` : "";
  const files = !selected
    ? []
    : selected.read.status === "complete"
      ? selected.read.revision.files.map((file) => ({
          relativePath: `${selected.location.folderPath}/${file.path}`,
          role: file.path === "SKILL.md" ? "content" : "support",
        }))
      : (details?.files.filter(
          (file) => file.relativePath === skillPath || file.relativePath.startsWith(`${selected.location.folderPath}/`),
        ) ?? []);
  const [path, setPath] = useState(skillPath);
  const { state, read, cancel } = useResourceDocument({ api: props.api, onEnsureGrant: props.onEnsureGrant });
  const entry: EntryRef | undefined = selected?.ref.entry;

  useEffect(() => {
    setSelectedKey((current) =>
      props.node.members.some((member) => memberKey(member) === current)
        ? current
        : initialMember && props.node.members.length
          ? memberKey(initialMember)
          : props.node.members[0]
            ? memberKey(props.node.members[0])
            : "",
    );
  }, [initialMember, props.node]);
  useEffect(() => {
    if (props.node.members.length === 0) setTab("metadata");
  }, [props.node.members.length]);
  useEffect(() => setPath(skillPath), [skillPath]);
  useEffect(() => {
    if (tab === "document" && path && entry) read(entry, path);
  }, [entry?.id, entry?.kind, path, read, tab]);
  useEffect(() => () => cancel(), [cancel]);

  const response = state.status === "result" && state.document.relativePath === path ? state.document.response : null;
  const documentMessage =
    response?.status === "denied"
      ? t("canvas.fileDenied")
      : response?.status === "unavailable" || response?.status === "corrupt"
        ? t("canvas.fileUnavailable")
        : response?.status === "too-large"
          ? t("canvas.tooLarge")
          : response?.status === "binary"
            ? t("canvas.binary")
            : response?.status === "read" && response.truncated
              ? t("canvas.truncated")
              : null;
  return (
    <SheetFrame
      title={props.node.label}
      label={t("canvas.skillCopiesInfo", { name: props.node.label })}
      kicker={t("canvas.logicalSkill")}
      testId="skill-copies-sheet"
      inert={props.inert}
      resizeKind={tab !== "metadata" ? "document" : "details"}
      onClose={() => {
        cancel();
        props.onClose();
      }}
      tabs={
        props.node.members.length ? (
          <nav aria-label={t("canvas.skillCopiesInfo", { name: props.node.label })} className="canvas-sheet-tabs">
            <button
              aria-current={tab === "metadata" ? "page" : undefined}
              onClick={() => setTab("metadata")}
              type="button"
            >
              {t("canvas.overview")}
            </button>
            <button
              aria-current={tab === "document" ? "page" : undefined}
              onClick={() => {
                setPath(skillPath);
                setTab("document");
              }}
              type="button"
            >
              SKILL.md
            </button>
            <button aria-current={tab === "files" ? "page" : undefined} onClick={() => setTab("files")} type="button">
              {t("canvas.skillFiles")}
            </button>
          </nav>
        ) : null
      }
    >
      {selected || initialLeft ? (
        <div className="canvas-copy-location">
          {selected ? (
            <label>
              <span>{t("canvas.skillLocation")}</span>
              <select
                aria-label={t("canvas.skillLocation")}
                value={memberKey(selected)}
                onChange={(event) => {
                  const member = props.node.members.find((candidate) => memberKey(candidate) === event.target.value);
                  if (!member) return;
                  cancel();
                  setSelectedKey(memberKey(member));
                  setPath(`${member.location.folderPath}/SKILL.md`);
                }}
              >
                {props.node.members.map((member) => (
                  <option key={memberKey(member)} value={memberKey(member)}>
                    {harnessLabel(member.location.harnessId)} · {member.location.folderPath}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="canvas-copy-location-label">{t("canvas.skillLocation")}</span>
          )}
          <div className="canvas-copy-location-actions">
            <code>{selected ? skillPath : initialLeft.folderPath}</code>
            {props.onCompare ? (
              <button
                className="canvas-secondary-button"
                disabled={!initialLeft}
                onClick={(event) => initialLeft && props.onCompare?.(initialLeft, event.currentTarget)}
                type="button"
              >
                {t("skillManagement.compareAndManage")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {tab === "metadata" ? (
        <>
          <p>
            <span className="canvas-meta-label">{t("canvas.skillRelationship")}</span> {props.group.label}
          </p>
          {props.group.source ? (
            <p>
              <span className="canvas-meta-label">{t("canvas.declaredSource")}</span>{" "}
              <code>{props.group.source.locator}</code>
            </p>
          ) : null}
          {sourceDetails ? (
            <p>
              <span className="canvas-meta-label">{t("canvas.inspectSourcePlugin")}</span>{" "}
              {sourceDetails.resource.label}
            </p>
          ) : null}
          <p>
            <span className="canvas-meta-label">{t("canvas.skillIdentity")}</span> <code>{props.node.skillId}</code>
          </p>
          <p>
            <span className="canvas-meta-label">{t("canvas.skillIdentityEvidence")}</span>{" "}
            {t(`canvas.skillEvidence.${props.node.record.evidence}`)}
          </p>
          {props.node.record.declaration ? (
            <>
              <p>
                <span className="canvas-meta-label">{t("canvas.declaredSource")}</span>{" "}
                <code>{props.node.record.declaration.locator}</code>
              </p>
              <p>
                <span className="canvas-meta-label">{t("canvas.skillKey")}</span>{" "}
                <code>{props.node.record.declaration.skillKey}</code>
              </p>
              {props.node.record.declaration.upstreamPath ? (
                <p>
                  <span className="canvas-meta-label">{t("canvas.upstreamSkillPath")}</span>{" "}
                  <code>{props.node.record.declaration.upstreamPath}</code>
                </p>
              ) : null}
            </>
          ) : null}
          <h3 className="canvas-location-heading">{t("canvas.groupLocations")}</h3>
          <ul className="canvas-file-list canvas-location-list">
            {props.node.locations.map((copy) => {
              const memberPath = `${copy.location.folderPath}/SKILL.md`;
              const origin = props.group.locations.find((candidate) => candidate.relativePath === memberPath);
              return (
                <li key={JSON.stringify(copy.location)}>
                  <code>
                    {harnessLabel(copy.location.harnessId)} · {copy.location.folderPath}
                  </code>
                  <p>
                    {verificationText(props.group, origin, t)} ·{" "}
                    {copy.read.status === "complete" ? t("canvas.skillTreeObserved") : t("canvas.skillTreeUnavailable")}
                  </p>
                  {verificationReason(origin, t) ? <p>{verificationReason(origin, t)}</p> : null}
                  {origin?.origin ? (
                    <>
                      <p>
                        <span className="canvas-meta-label">{t("canvas.evidenceFile")}</span>{" "}
                        <code>{origin.origin.lockPath}</code>
                      </p>
                      {origin.origin.reference ? (
                        <p>
                          <span className="canvas-meta-label">{t("canvas.upstreamReference")}</span>{" "}
                          <code>{origin.origin.reference}</code>
                        </p>
                      ) : null}
                      {origin.origin.sourceSkillPath ? (
                        <p>
                          <span className="canvas-meta-label">{t("canvas.upstreamSkillPath")}</span>{" "}
                          <code>{origin.origin.sourceSkillPath}</code>
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  {origin?.membershipIssue ? (
                    <p className="canvas-error">{membershipIssueText(origin.membershipIssue, t)}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : tab === "files" ? (
        selected ? (
          <>
            {files.length ? (
              <ul className="canvas-file-list" aria-label={t("canvas.files")}>
                {files.map((file) => (
                  <li key={file.relativePath}>
                    <button
                      aria-current={file.relativePath === path ? "true" : undefined}
                      onClick={() => {
                        setPath(file.relativePath);
                        setTab("document");
                      }}
                      type="button"
                    >
                      <span>{file.relativePath.slice(selected.location.folderPath.length + 1)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("canvas.fileUnavailable")}</p>
            )}
          </>
        ) : (
          <p>{t("canvas.fileUnavailable")}</p>
        )
      ) : (
        <div className="canvas-document">
          {selected && path !== skillPath ? (
            <div className="canvas-document-toolbar">
              <code title={path}>{path}</code>
            </div>
          ) : null}
          {state.status === "loading" ? <p aria-live="polite">{t("canvas.loading")}</p> : null}
          {documentMessage ? <p className="canvas-error">{documentMessage}</p> : null}
          {response?.status === "read" ? (
            <AssetContent
              content={response.content}
              path={path}
              presentation="document"
              truncated={response.truncated}
            />
          ) : null}
        </div>
      )}
    </SheetFrame>
  );
}
