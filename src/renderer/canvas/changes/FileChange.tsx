import type { ReactElement } from "react";
import type { SkillFileSummary } from "../../../shared/skill-management-ipc";
import type { TranslationFunction } from "../../i18n";
import { parseDiffLines } from "./diff-lines";
import { DiffLines } from "./DiffLines";

export function FileChange({
  file,
  layout,
  rootName,
  local,
  commonBaseHash,
  t,
}: Readonly<{
  file: SkillFileSummary;
  layout: "unified" | "split";
  rootName: string;
  local: boolean;
  commonBaseHash?: string;
  t: TranslationFunction;
}>): ReactElement {
  const excerpt = file.diff ? parseDiffLines(file.diff) : null;
  const changeLabel = t(
    file.change === "add"
      ? "skillManagement.fileAdded"
      : file.change === "delete"
        ? "skillManagement.fileDeleted"
        : file.change === "unchanged"
          ? "skillManagement.fileUnchanged"
          : "skillManagement.fileChanged",
  );
  const currentLabel = t(local ? "skillManagement.currentLocal" : "skillManagement.currentSource");
  return (
    <article className="changes-file">
      <header>
        <span aria-label={changeLabel} className={`changes-sign is-${file.change}`}>
          {file.change === "add" ? "+" : file.change === "delete" ? "−" : file.change === "unchanged" ? "·" : "~"}
        </span>
        <div>
          <small>{rootName}</small>
          <code>{file.relativePath}</code>
        </div>
        {file.byteLength === undefined ? null : <small>{file.byteLength.toLocaleString()} B</small>}
      </header>
      <div className="changes-provenance">
        <div>
          <span>{currentLabel}</span>
          <code>
            {file.beforeHash?.slice(0, 12) ??
              t(file.change === "add" ? "skillManagement.fileMissing" : "skillManagement.notRecorded")}
          </code>
        </div>
        <div>
          <span>{t("skillManagement.proposed")}</span>
          <code>
            {file.afterHash?.slice(0, 12) ??
              t(file.change === "delete" ? "skillManagement.fileDeleted" : "skillManagement.notRecorded")}
          </code>
        </div>
        <div>
          <span>{t("skillManagement.commonBase")}</span>
          <code>{commonBaseHash?.slice(0, 12) ?? t("skillManagement.notRecorded")}</code>
        </div>
      </div>
      {excerpt?.lines.length ? (
        <DiffLines
          lines={excerpt.lines}
          layout={layout}
          beforeLabel={currentLabel}
          afterLabel={t("skillManagement.proposed")}
          layoutLabel={t(layout === "unified" ? "skillManagement.unified" : "skillManagement.split")}
        />
      ) : (
        <p className="changes-note">
          {file.summary ??
            excerpt?.summary ??
            t(file.change === "unchanged" ? "skillManagement.fileUnchanged" : "skillManagement.hashOnly")}
        </p>
      )}
      {excerpt?.truncated ? <p className="changes-note">{t("skillManagement.diffTruncated")}</p> : null}
    </article>
  );
}
