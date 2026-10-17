import { LoadingSkeleton } from "../components/ui/Skeleton";
import { useEffect, type ReactElement } from "react";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { useResourceDocument } from "./use-resource-document";
import { useI18n } from "../i18n";
import { AssetContent } from "../assets/AssetContent";

export function ProjectDocument(
  props: Readonly<{
    projectId: string;
    raw?: boolean;
    path?: string;
    api: ResourceCanvasProps["api"];
    onEnsureGrant: ResourceCanvasProps["onEnsureGrant"];
  }>,
): ReactElement {
  const { t } = useI18n();
  const { state, read, cancel } = useResourceDocument(props);
  useEffect(() => {
    if (props.path) read({ kind: "project", id: props.projectId }, props.path);
    else cancel();
    return cancel;
  }, [props.path, props.projectId, read, cancel]);
  const response = state.status === "result" ? state.document.response : null;
  return (
    <div className={props.raw ? "skill-document-container" : "canvas-document"}>
      {props.path && !props.raw ? <code>{props.path}</code> : props.path ? null : <p>{t("projectView.noContent")}</p>}
      {state.status === "loading" ? (
        <LoadingSkeleton label={t("canvas.loadingSurface", { surface: t("canvas.document") })} variant="document" />
      ) : null}
      {response?.status === "read" && props.raw ? (
        <pre className="skill-document">{response.content}</pre>
      ) : response?.status === "read" ? (
        <AssetContent
          path={props.path ?? "SKILL.md"}
          content={response.content}
          presentation="document"
          truncated={response.truncated}
        />
      ) : response ? (
        <div role="alert">
          <p>
            {t(
              response.status === "denied"
                ? "canvas.fileDenied"
                : response.status === "too-large"
                  ? "canvas.tooLarge"
                  : response.status === "binary"
                    ? "canvas.binary"
                    : "canvas.fileUnavailable",
            )}
          </p>
          <button
            className="canvas-secondary-button"
            type="button"
            onClick={() => props.path && read({ kind: "project", id: props.projectId }, props.path)}
          >
            {t("canvas.retry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
