import { useMemo, type ReactElement } from "react";

import type { SkillCopyComparisonResponse } from "../../../shared/skill-copy-comparison-ipc";
import { useI18n, tCount } from "../../i18n";
import { DiffLines } from "./DiffLines";
import { parseDiffLines } from "./diff-lines";

type ReadyResponse = Extract<SkillCopyComparisonResponse, { status: "ready" }>;

export function CopyComparisonContent(
  props: Readonly<{
    response: ReadyResponse;
    selectedPath?: string;
    fileScope?: "all" | "changes";
    layout: "unified" | "split";
    copyALabel: string;
    copyBLabel: string;
    onSelectFile: (path: string) => void;
    onLayoutChange: (layout: "unified" | "split") => void;
  }>,
): ReactElement {
  const { t, language } = useI18n();
  const changedCount = props.response.files.filter((file) => file.change !== "unchanged").length;
  const files =
    props.fileScope === "changes"
      ? props.response.files.filter((file) => file.change !== "unchanged")
      : props.response.files;
  const selectedFile = files.find((file) => file.path === props.selectedPath) ?? files[0];
  const presentation =
    selectedFile && props.response.selectedPath === selectedFile.path ? props.response.presentation : undefined;
  const parsed = useMemo(
    () => (presentation?.presentation === "text" ? parseDiffLines(presentation.diff ?? "") : null),
    [presentation],
  );

  return (
    <section aria-label={t("skillManagement.comparedFiles")} className="changes-comparison-content">
      <p className="changes-comparison-summary">
        {t("skillManagement.copyDifferencesSummary", {
          changed: tCount("skillManagement.copyChangedFileCount", changedCount, {}, language),
          total: tCount("skillManagement.copyComparedFileCount", props.response.files.length, {}, language),
        })}
      </p>
      <details className="copy-management-details">
        <summary>{t("canvas.details")}</summary>
        <div className="changes-provenance">
          <div>
            <span>{props.copyALabel}</span>
            <code>{props.response.a.location.folderPath}</code>
            <code>
              {selectedFile
                ? (selectedFile.left?.hash ?? t("skillManagement.fileMissing"))
                : props.response.a.read.status === "complete"
                  ? props.response.a.read.revision.hash
                  : t("skillManagement.fileMissing")}
            </code>
          </div>
          <div>
            <span>{props.copyBLabel}</span>
            <code>{props.response.b.location.folderPath}</code>
            <code>
              {selectedFile
                ? (selectedFile.right?.hash ?? t("skillManagement.fileMissing"))
                : props.response.b.read.status === "complete"
                  ? props.response.b.read.revision.hash
                  : t("skillManagement.fileMissing")}
            </code>
          </div>
        </div>
      </details>
      <div className="changes-diff-toolbar">
        <span>{t("skillManagement.comparedFiles")}</span>
        <div aria-label={t("skillManagement.diffLayout")} role="group">
          <button
            aria-pressed={props.layout === "unified"}
            onClick={() => props.onLayoutChange("unified")}
            type="button"
          >
            {t("skillManagement.unified")}
          </button>
          <button aria-pressed={props.layout === "split"} onClick={() => props.onLayoutChange("split")} type="button">
            {t("skillManagement.split")}
          </button>
        </div>
      </div>
      <div aria-label={t("skillManagement.comparedFiles")} className="changes-comparison-list">
        {files.map((file) => (
          <button
            aria-pressed={selectedFile?.path === file.path}
            className="changes-comparison-file"
            key={file.path}
            onClick={() => props.onSelectFile(file.path)}
            type="button"
          >
            <span
              aria-label={t(
                file.change === "add"
                  ? "skillManagement.fileAdded"
                  : file.change === "delete"
                    ? "skillManagement.fileDeleted"
                    : file.change === "unchanged"
                      ? "skillManagement.fileUnchanged"
                      : "skillManagement.fileChanged",
              )}
              className={`changes-sign is-${file.change}`}
            >
              {file.change === "add" ? "+" : file.change === "delete" ? "−" : file.change === "unchanged" ? "·" : "~"}
            </span>
            <code>{file.path}</code>
            <small>
              {t(
                file.change === "add"
                  ? "skillManagement.fileAdded"
                  : file.change === "delete"
                    ? "skillManagement.fileDeleted"
                    : file.change === "unchanged"
                      ? "skillManagement.fileUnchanged"
                      : "skillManagement.fileChanged",
              )}
            </small>
          </button>
        ))}
      </div>
      {selectedFile ? (
        <article aria-label={selectedFile.path} className="changes-file changes-comparison-detail">
          <header>
            <code>{selectedFile.path}</code>
          </header>
          {presentation?.presentation === "text" && parsed?.lines.length ? (
            <DiffLines
              lines={parsed.lines}
              layout={props.layout}
              beforeLabel={props.copyALabel}
              afterLabel={props.copyBLabel}
              layoutLabel={t(props.layout === "unified" ? "skillManagement.unified" : "skillManagement.split")}
            />
          ) : null}
          {presentation?.presentation === "binary" ? (
            <p className="changes-note">{t("skillManagement.binaryComparison")}</p>
          ) : null}
          {presentation?.presentation === "too-large" ? (
            <p className="changes-note">{t("skillManagement.largeComparison")}</p>
          ) : null}
          {presentation?.presentation === "unchanged" ||
          (presentation?.presentation === "text" && !parsed?.lines.length) ? (
            <p className="changes-note">{t("skillManagement.identicalComparison")}</p>
          ) : null}
          {presentation?.presentation === "text" && presentation.byteDifferenceNotice ? (
            <p className="changes-note">{t("skillManagement.byteDifferenceNotice")}</p>
          ) : null}
          {presentation?.presentation === "text" && (presentation.truncated || parsed?.truncated) ? (
            <p className="changes-note">{t("skillManagement.diffTruncated")}</p>
          ) : null}
        </article>
      ) : (
        <p className="changes-empty">
          {t(
            changedCount === 0 && props.response.files.length > 0
              ? "skillManagement.identicalComparison"
              : "skillManagement.noComparedFiles",
          )}
        </p>
      )}
    </section>
  );
}
