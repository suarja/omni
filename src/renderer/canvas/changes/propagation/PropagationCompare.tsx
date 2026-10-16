import { useState, type ReactElement } from "react";
import type { SkillPropagationSummary } from "../../../../shared/skill-propagation-ipc";
import type { TranslationFunction } from "../../../i18n";
import { Icon } from "../../../components/Icon";
import { DiffLines } from "../DiffLines";
import { parseDiffLines } from "../diff-lines";
import type { buildPropagationView } from "./view-model";
import { PropagationDetails } from "./PropagationDetails";
import { harnessName } from "./labels";

type View = ReturnType<typeof buildPropagationView>;
export function PropagationCompare({
  summary,
  view,
  nameFor,
  t,
}: Readonly<{
  summary: SkillPropagationSummary;
  view: View;
  nameFor: (id: string) => string;
  t: TranslationFunction;
}>): ReactElement {
  const [copy, setCopy] = useState("");
  const [path, setPath] = useState("");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const location = view.locations.find((item) => item.key === copy) ?? view.locations[0];
  const files = location?.files.filter((file) => file.change !== "unchanged") ?? [];
  const file = files.find((item) => item.relativePath === path) ?? files[0];
  const excerpt = file?.diff ? parseDiffLines(file.diff) : null;
  const retained = location?.group === "retained";
  const binary = file?.diff && /: binary content (?:updated|added|deleted) \(\d+ bytes\)\.$/u.test(file.diff);
  const fileName = (value: string): string =>
    location && value.startsWith(location.target.location.folderPath + "/")
      ? value.slice(location.target.location.folderPath.length + 1)
      : value;
  return (
    <section className="propagation-compare" data-testid="changes-diff">
      <div className="propagation-fields">
        <label className="canvas-select-field">
          <span>{t("skillManagement.propagationCopy")}</span>
          <span className="canvas-select-control">
            <select
              aria-label={t("skillManagement.propagationCopy")}
              value={location?.key ?? ""}
              onChange={(event) => {
                setCopy(event.target.value);
                setPath("");
              }}
            >
              {view.locations.map((item) => (
                <option key={item.key} value={item.key}>
                  {nameFor(item.target.location.projectId)} · {harnessName(item.target.location.harnessId)}
                  {view.locations.filter(
                    (other) =>
                      other.target.location.projectId === item.target.location.projectId &&
                      other.target.location.harnessId === item.target.location.harnessId,
                  ).length > 1
                    ? ` · ${item.target.location.folderPath}`
                    : ""}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={13} />
          </span>
        </label>
        <label className="canvas-select-field">
          <span>{t("skillManagement.propagationView")}</span>
          <span className="canvas-select-control">
            <select
              aria-label={t("skillManagement.propagationView")}
              value={layout}
              onChange={(event) => setLayout(event.target.value as "unified" | "split")}
            >
              <option value="unified">{t("skillManagement.unified")}</option>
              <option value="split">{t("skillManagement.split")}</option>
            </select>
            <Icon name="chevron-down" size={13} />
          </span>
        </label>
      </div>
      {retained ? (
        <p className="propagation-notice" data-tone="review">
          <Icon name="review" />
          {t("skillManagement.propagationStateRetained")}
        </p>
      ) : null}
      {location?.group === "unavailable" ? (
        <p className="propagation-notice" data-tone="unknown">
          {location.target.reason ?? t("skillManagement.selectedCopyUnavailable")}
        </p>
      ) : (
        <>
          <p className="propagation-file-summary">
            <span>{t("skillManagement.propagationFileCount", { count: files.length })}</span>
            <span>
              {t(retained ? "skillManagement.propagationBaseToLocal" : "skillManagement.propagationCopyToMarketplace")}
            </span>
          </p>
          <nav aria-label={t("skillManagement.reviewedFiles")} className="propagation-files">
            {files.map((item) => (
              <button
                key={item.relativePath}
                type="button"
                data-propagation-file={item.relativePath}
                aria-pressed={item === file}
                title={fileName(item.relativePath)}
                onClick={() => setPath(item.relativePath)}
              >
                <Icon name="instruction" size={14} />
                {fileName(item.relativePath)}
              </button>
            ))}
          </nav>
          {file ? (
            <section className="propagation-file-content">
              <h3>{fileName(file.relativePath)}</h3>
              {excerpt?.lines.length ? (
                <DiffLines
                  lines={excerpt.lines}
                  layout={layout}
                  beforeLabel={t(retained ? "skillManagement.commonBase" : "skillManagement.currentLocal")}
                  afterLabel={t(retained ? "skillManagement.currentLocal" : "skillManagement.source")}
                  layoutLabel={t(layout === "unified" ? "skillManagement.unified" : "skillManagement.split")}
                />
              ) : (
                <p className="propagation-binary">
                  {binary
                    ? t(
                        `skillManagement.propagationBinary${file.change === "add" ? "Added" : file.change === "delete" ? "Deleted" : "Updated"}`,
                      )
                    : t(retained ? "skillManagement.propagationLocalDiffUnavailable" : "skillManagement.hashOnly")}
                  {binary && file.byteLength !== undefined ? ` · ${file.byteLength} B` : ""}
                </p>
              )}
              {excerpt?.truncated ? <p className="changes-note">{t("skillManagement.diffTruncated")}</p> : null}
              <details className="propagation-details">
                <summary>{t("skillManagement.propagationFileDetails")}</summary>
                <code>{file.relativePath}</code>
                <p>
                  {file.beforeHash ?? t("skillManagement.notRecorded")} →{" "}
                  {file.afterHash ?? t("skillManagement.notRecorded")}
                </p>
              </details>
            </section>
          ) : (
            <p className="changes-note">
              {t(retained ? "skillManagement.propagationLocalDiffUnavailable" : "skillManagement.emptyDiff")}
            </p>
          )}
        </>
      )}
      <PropagationDetails summary={summary} target={location?.target} t={t} />
    </section>
  );
}
