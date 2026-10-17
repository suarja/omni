import { LoadingSkeleton } from "../components/ui/Skeleton";
import { activeWorkshop } from "../../domain/source-roles";
import { harnessLabel } from "./project-view-model";
import { useEffect, useState, type ReactElement } from "react";
import { useLinkedSkillMaintenance } from "./use-linked-skill-maintenance";
import type { SkillPropagationIntent } from "../../shared/skill-propagation-ipc";
import { SheetFrame } from "./SheetFrame";

import type { ResourceDetails, ResourceSnapshot } from "../../domain/resource-catalogue";
import type { EntryRef } from "../../domain/project-source-registry";
import type { DesktopApi } from "../../shared/ipc";
import { AssetContent } from "../assets/AssetContent";
import { useI18n } from "../i18n";
import { ResourceOriginDetails } from "./ResourceOriginDetails";
import { SkillVariantOriginDetails } from "./SkillVariantOriginDetails";
import { useResourceDocument } from "./use-resource-document";

export function ResourceSheet(
  props: Readonly<{
    details: ResourceDetails;
    snapshot: ResourceSnapshot;
    api:
      | (Pick<
          DesktopApi,
          | "readArtifact"
          | "previewSkillOperation"
          | "refreshSkillOperation"
          | "applySkillOperation"
          | "readSkillOperationResult"
        > &
          Partial<Pick<DesktopApi, "readSkillVariantOrigin">>)
      | null;
    onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
    onClose: () => void;
    onOpenChanges: (sourceId?: string, packageId?: string, projectId?: string, journey?: "draft" | "assign") => void;
    onOpenMaintenance?: (intent: SkillPropagationIntent) => void;
    onOpenRemoval: (bindingId: string) => void;
    initialDocument?: boolean;
    initialPath?: string;
  }>,
): ReactElement {
  const { t } = useI18n();
  const resource = props.details.resource;
  const maintenance = useLinkedSkillMaintenance(props.details, props.snapshot, props.api);
  const defaultPath =
    props.details.files.find((file) => file.role === "content" || file.role === "readme")?.relativePath ?? "";
  const selectedPath =
    props.initialPath && props.details.files.some((file) => file.relativePath === props.initialPath)
      ? props.initialPath
      : undefined;
  const initialPath = selectedPath ?? defaultPath;
  const displayedPath = selectedPath ?? resource.relativePath;
  const [tab, setTab] = useState<"overview" | "document" | "files">(props.initialDocument ? "document" : "overview");
  const [path, setPath] = useState(initialPath);
  const [original, setOriginal] = useState(false);
  const { state, read, cancel } = useResourceDocument({ api: props.api, onEnsureGrant: props.onEnsureGrant });
  const entry = props.details.resource.ref.entry;
  const ownedSource =
    entry.kind === "source"
      ? activeWorkshop(props.snapshot.registry)?.ref.id === entry.id
        ? activeWorkshop(props.snapshot.registry)
        : undefined
      : undefined;
  const packageId =
    props.details.resource.ref.kind === "package"
      ? props.details.resource.ref.packageId
      : props.details.parent?.kind === "package"
        ? props.details.parent.packageId
        : undefined;
  useEffect(() => {
    setPath(initialPath);
  }, [initialPath]);
  useEffect(() => {
    if (tab === "document" && path) read(entry, path);
  }, [tab, path, entry.kind, entry.id, read]);
  useEffect(() => () => cancel(), [cancel]);
  const response = state.status === "result" && state.document.relativePath === path ? state.document.response : null;
  const typeLabel =
    resource.kind === "project"
      ? t("canvas.project")
      : resource.kind === "marketplace"
        ? t("canvas.source")
        : resource.kind === "external-source"
          ? t("canvas.external")
          : resource.kind === "plugin"
            ? t("canvas.plugin")
            : t("canvas.artifact");
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
      title={resource.label}
      label={t("canvas.info", { name: resource.label })}
      kicker={typeLabel}
      testId="resource-sheet"
      resizeKind={tab === "document" ? "document" : "details"}
      onClose={() => {
        cancel();
        props.onClose();
      }}
      tabs={
        <nav aria-label={t("canvas.info", { name: resource.label })} className="canvas-sheet-tabs">
          <button
            aria-current={tab === "overview" ? "page" : undefined}
            onClick={() => setTab("overview")}
            type="button"
          >
            {t("canvas.overview")}
          </button>
          <button
            aria-current={tab === "document" ? "page" : undefined}
            disabled={!props.details.files.length}
            onClick={() => setTab("document")}
            type="button"
          >
            {t("canvas.document")}
          </button>
          <button aria-current={tab === "files" ? "page" : undefined} onClick={() => setTab("files")} type="button">
            {t("canvas.files")}
          </button>
        </nav>
      }
    >
      {tab === "overview" ? (
        <>
          {resource.description ? <p className="canvas-description">{resource.description}</p> : null}
          {displayedPath ? (
            <p>
              <span className="canvas-meta-label">{t("canvas.path")}</span>
              <code>{displayedPath}</code>
            </p>
          ) : null}
          {resource.version ? <p>{t("canvas.version", { value: resource.version })}</p> : null}
          {props.details.packageFormat ? (
            <p>
              <span className="canvas-meta-label">{t("canvas.packageFormat")}</span>
              <code>{props.details.packageFormat}</code>
            </p>
          ) : null}
          {resource.observedAt ? (
            <p className="canvas-observed-at">{t("canvas.observedAt", { value: resource.observedAt })}</p>
          ) : null}
          {resource.unavailableReason ? (
            <p className="canvas-error">
              {t("canvas.unavailableReason", {
                reason: t(
                  `canvas.${resource.unavailableReason}` as
                    "canvas.missing" | "canvas.inaccessible" | "canvas.denied" | "canvas.failed",
                ),
              })}
            </p>
          ) : null}
          <ResourceOriginDetails details={props.details} displayedPath={displayedPath} />
          <SkillVariantOriginDetails
            api={
              props.api?.readSkillVariantOrigin ? { readSkillVariantOrigin: props.api.readSkillVariantOrigin } : null
            }
            details={props.details}
            snapshot={props.snapshot}
          />
          <section className="canvas-use-section">
            <h3>{t("canvas.recordedUses")}</h3>
            {props.details.uses.status === "loading" ? (
              <LoadingSkeleton label={t("canvas.bindingLoading")} variant="rows" />
            ) : null}
            {props.details.uses.status === "unavailable" ? <p>{t("canvas.bindingUnavailable")}</p> : null}
            {props.details.uses.status === "ready" && props.details.uses.bindings.length === 0 ? (
              <p>{t("canvas.noUses")}</p>
            ) : null}
            {props.details.uses.status === "ready" && props.details.uses.bindings.length ? (
              <ul className="canvas-binding-list">
                {props.details.uses.bindings.map((binding) => {
                  const project = props.snapshot.registry.projects.find((entry) => entry.ref.id === binding.projectId);
                  const workshop = activeWorkshop(props.snapshot.registry);
                  const source = workshop?.ref.id === binding.sourceId ? workshop : undefined;
                  return (
                    <li key={binding.bindingId}>
                      <span>
                        {project?.displayName ?? binding.projectId} · {harnessLabel(binding.harnessId)}
                      </span>
                      {source ? (
                        <button
                          className="canvas-secondary-button"
                          onClick={() => props.onOpenRemoval(binding.bindingId)}
                          type="button"
                        >
                          {t("skillManagement.removeUse")}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <p className="canvas-muted-note">{t("canvas.providerState")}</p>
          </section>
          <div className="canvas-sheet-actions">
            {maintenance.intent && props.onOpenMaintenance ? (
              <button
                className="canvas-secondary-button"
                data-testid="update-linked-copies"
                type="button"
                onClick={() => maintenance.intent && props.onOpenMaintenance?.(maintenance.intent)}
              >
                {t("skillManagement.updateLinkedCopies", { count: maintenance.count })}
              </button>
            ) : null}
            {ownedSource ? (
              <>
                <button
                  className="canvas-secondary-button"
                  onClick={() => props.onOpenChanges(ownedSource.ref.id, packageId, undefined, "draft")}
                  type="button"
                >
                  {t("skillManagement.newDraft")}
                </button>
                <button
                  className="canvas-secondary-button"
                  onClick={() => props.onOpenChanges(ownedSource.ref.id, packageId, undefined, "assign")}
                  type="button"
                >
                  {t("skillManagement.assignSkills")}
                </button>
              </>
            ) : null}
            {entry.kind === "project" ? (
              <button
                className="canvas-secondary-button"
                onClick={() => props.onOpenChanges(undefined, undefined, entry.id, "assign")}
                type="button"
              >
                {t("skillManagement.assignSkills")}
              </button>
            ) : null}
          </div>
        </>
      ) : tab === "files" ? (
        <ul className="canvas-file-list">
          {props.details.files.map((file) => (
            <li key={`${file.role}:${file.relativePath}`}>
              <button
                onClick={() => {
                  setPath(file.relativePath);
                  setOriginal(false);
                  setTab("document");
                }}
                type="button"
              >
                <span>{file.relativePath}</span>
                <small>{file.role}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="canvas-document">
          <div className="canvas-document-toolbar">
            <code title={path}>{path}</code>
            <button
              aria-pressed={original}
              className="canvas-secondary-button"
              onClick={() => setOriginal(!original)}
              type="button"
            >
              {original ? t("canvas.rendered") : t("canvas.original")}
            </button>
          </div>
          {state.status === "loading" ? (
            <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("canvas.document") })} variant="document" />
          ) : null}
          {!path ? <p>{t("canvas.fileUnavailable")}</p> : null}
          {documentMessage ? (
            <div className="canvas-document-error">
              <p>{documentMessage}</p>
              <button className="canvas-secondary-button" onClick={() => read(entry, path)} type="button">
                {t("canvas.retry")}
              </button>
            </div>
          ) : null}
          {response?.status === "read" ? (
            original ? (
              <pre className="canvas-original-text">{response.content}</pre>
            ) : (
              <AssetContent
                content={response.content}
                path={path}
                presentation="document"
                truncated={response.truncated}
              />
            )
          ) : null}
        </div>
      )}
    </SheetFrame>
  );
}
