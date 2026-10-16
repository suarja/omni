import { useState, type ReactElement } from "react";
import type { SkillFileSummary } from "../../../shared/skill-management-ipc";
import { useI18n } from "../../i18n";
import { DiffLines } from "./DiffLines";
import { parseDiffLines } from "./diff-lines";

export function CopyFileEffects(
  props: Readonly<{ files: readonly SkillFileSummary[]; projectId: string }>,
): ReactElement | null {
  const { t } = useI18n();
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  if (!props.files.length) return null;
  return (
    <div>
      <div className="changes-diff-toolbar">
        <span>{t("skillManagement.reviewedFiles")}</span>
        <div role="group" aria-label={t("skillManagement.diffLayout")}>
          {(["unified", "split"] as const).map((choice) => (
            <button key={choice} type="button" aria-pressed={layout === choice} onClick={() => setLayout(choice)}>
              {t(`skillManagement.${choice}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="changes-file-list">
        {props.files.map((file) => {
          const excerpt = file.diff ? parseDiffLines(file.diff) : null;
          const currentLabel = t(
            file.rootId === props.projectId ? "skillManagement.currentLocal" : "skillManagement.currentSource",
          );
          const changeKey =
            file.change === "add" ? "fileAdded" : file.change === "delete" ? "fileDeleted" : "fileChanged";
          return (
            <article className="changes-file" key={`${file.rootId}:${file.relativePath}`}>
              <header>
                <span aria-label={t(`skillManagement.${changeKey}`)} className={`changes-sign is-${file.change}`}>
                  {file.change === "add" ? "+" : file.change === "delete" ? "−" : "~"}
                </span>
                <code>{file.relativePath}</code>
              </header>
              {excerpt?.lines.length ? (
                <DiffLines
                  lines={excerpt.lines}
                  layout={layout}
                  beforeLabel={currentLabel}
                  afterLabel={t("skillManagement.proposed")}
                  layoutLabel={t(`skillManagement.${layout}`)}
                />
              ) : (
                <p className="changes-note">{file.summary ?? excerpt?.summary ?? t("skillManagement.hashOnly")}</p>
              )}
              {excerpt?.truncated ? <p className="changes-note">{t("skillManagement.diffTruncated")}</p> : null}
              <details className="copy-management-details">
                <summary>{t("canvas.details")}</summary>
                <dl>
                  <div>
                    <dt>{currentLabel}</dt>
                    <dd>
                      <code>{file.beforeHash ?? t("skillManagement.fileMissing")}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("skillManagement.proposed")}</dt>
                    <dd>
                      <code>{file.afterHash ?? t("skillManagement.fileDeleted")}</code>
                    </dd>
                  </div>
                </dl>
              </details>
            </article>
          );
        })}
      </div>
    </div>
  );
}
