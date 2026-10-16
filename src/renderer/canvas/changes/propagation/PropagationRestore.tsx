import type { ReactElement } from "react";
import type { SkillEffectStep, SkillPreview, SkillFileSummary } from "../../../../shared/skill-management-ipc";
import type { SkillPropagationSummary } from "../../../../shared/skill-propagation-ipc";
import type { TranslationFunction, TranslationKey } from "../../../i18n";
import { Icon } from "../../../components/Icon";
import { DiffLines } from "../DiffLines";
import { parseDiffLines } from "../diff-lines";
import { locationKey } from "./view-model";
import { harnessName, toneIcons } from "./labels";

function inverseSteps(preview: SkillPreview): readonly SkillEffectStep[] {
  return preview.status === "ready" ? preview.steps.filter((step) => step.propagationEvidence !== undefined) : [];
}

function sourceSteps(summary: SkillPropagationSummary, preview: SkillPreview): readonly SkillEffectStep[] {
  return preview.status === "ready"
    ? preview.steps.filter(
        (step) =>
          step.scope.sourceId === summary.source.sourceId &&
          step.scope.targets.length === 0 &&
          step.propagationEvidence === undefined,
      )
    : [];
}

function statusKey(result: string | undefined): TranslationKey {
  if (result === "unknown") return "skillManagement.propagationRestoreRecovery";
  if (result === "failed") return "skillManagement.propagationRestoreFailed";
  if (result === "unavailable") return "skillManagement.propagationRestoreUnavailable";
  if (result === "retained-local") return "skillManagement.propagationRestoreRetained";
  return "skillManagement.propagationRestoreUntouched";
}

function binaryStatusKey(action: string | undefined): TranslationKey | undefined {
  if (action === "restored") return "skillManagement.propagationRestoreBinaryRestored";
  if (action === "deleted") return "skillManagement.propagationRestoreBinaryDeleted";
  if (action === "added") return "skillManagement.propagationRestoreBinaryAdded";
  if (action === "updated") return "skillManagement.propagationRestoreBinaryUpdated";
  return undefined;
}

export function PropagationRestore({
  summary,
  preview,
  nameFor,
  t,
}: Readonly<{
  summary: SkillPropagationSummary;
  preview: SkillPreview;
  nameFor: (id: string) => string;
  t: TranslationFunction;
}>): ReactElement {
  const steps = inverseSteps(preview);
  const sourceEffects = sourceSteps(summary, preview);
  const restored = new Set(steps.map((step) => locationKey(step.propagationEvidence!.location)));
  const untouched = summary.targets.filter((target) => !restored.has(locationKey(target.location)));
  return (
    <section className="propagation-restore" data-testid="changes-diff">
      <h3>{t("skillManagement.propagationRestoreTitle")}</h3>
      {sourceEffects.map((step) => (
        <article className="propagation-restore-target" data-tone="success" key={step.stepId}>
          <Icon name={toneIcons.success} />
          <div className="propagation-project-name">
            <strong>{nameFor(summary.source.sourceId)}</strong>
            <small>{t("skillManagement.propagationRestoreSource")}</small>
            <details className="propagation-details">
              <summary>{t("canvas.details")}</summary>
              <code>
                {summary.source.packageId}/{summary.source.artifactPath}
              </code>
            </details>
            {step.files
              .filter((file) => file.change !== "unchanged")
              .map((file) => {
                const root = `${summary.source.packageId}/${summary.source.artifactPath}/`;
                return (
                  <RestoreFile
                    file={file}
                    key={file.relativePath}
                    label={
                      file.relativePath.startsWith(root) ? file.relativePath.slice(root.length) : file.relativePath
                    }
                    t={t}
                  />
                );
              })}
          </div>
        </article>
      ))}
      {steps.map((step) => {
        const location = step.propagationEvidence!.location;
        const files = step.files.filter((file) => file.change !== "unchanged");
        return (
          <article className="propagation-restore-target" data-tone="success" key={step.stepId}>
            <Icon name={toneIcons.success} />
            <div className="propagation-project-name">
              <strong>{nameFor(location.projectId)}</strong>
              <small>
                {harnessName(location.harnessId)} · {t("skillManagement.propagationRestoreApplied")}
              </small>
              <details className="propagation-details">
                <summary>{t("canvas.details")}</summary>
                <code>{location.folderPath}</code>
              </details>
              {files.map((file) => (
                <RestoreFile
                  file={file}
                  key={file.relativePath}
                  label={
                    file.relativePath.startsWith(`${location.folderPath}/`)
                      ? file.relativePath.slice(location.folderPath.length + 1)
                      : file.relativePath
                  }
                  t={t}
                />
              ))}
            </div>
          </article>
        );
      })}
      {untouched.length ? (
        <section className="propagation-restore-untouched">
          <h4>{t("skillManagement.propagationRestoreUntouchedTitle")}</h4>
          {untouched.map((target) => (
            <article
              className="propagation-project-row"
              data-tone={target.result === "unknown" ? "unknown" : "review"}
              key={locationKey(target.location)}
            >
              <Icon name={target.result === "unknown" ? toneIcons.unknown : toneIcons.review} />
              <span className="propagation-project-name">
                {nameFor(target.location.projectId)}
                <small>{harnessName(target.location.harnessId)}</small>
              </span>
              <span className="propagation-project-status">{t(statusKey(target.result))}</span>
            </article>
          ))}
        </section>
      ) : null}
      <p className="changes-note">{t("skillManagement.propagationRestoreSafety")}</p>
    </section>
  );
}

function RestoreFile({
  file,
  label = file.relativePath,
  t,
}: Readonly<{
  file: SkillFileSummary;
  label?: string;
  t: TranslationFunction;
}>): ReactElement {
  const parsed = file.diff ? parseDiffLines(file.diff) : null;
  const binaryAction = file.diff?.match(/: binary content (updated|added|deleted|restored) \(\d+ bytes\)\.$/u)?.[1];
  const binaryKey = binaryStatusKey(binaryAction);
  return (
    <section className="propagation-restore-file">
      <h4>{label}</h4>
      {parsed?.lines.length ? (
        <DiffLines
          lines={parsed.lines}
          layout="unified"
          beforeLabel={t("skillManagement.propagationRestoreCurrent")}
          afterLabel={t("skillManagement.propagationRestorePrevious")}
          layoutLabel={t("skillManagement.unified")}
        />
      ) : (
        <p className="propagation-binary">
          {binaryKey ? t(binaryKey) : t("skillManagement.hashOnly")}
          {binaryAction && file.byteLength !== undefined ? ` · ${file.byteLength} B` : ""}
        </p>
      )}
      {parsed?.truncated ? <p className="changes-note">{t("skillManagement.diffTruncated")}</p> : null}
      <details className="propagation-details">
        <summary>{t("skillManagement.propagationFileDetails")}</summary>
        <code>{file.relativePath}</code>
        <p>
          {file.beforeHash ?? t("skillManagement.notRecorded")} → {file.afterHash ?? t("skillManagement.notRecorded")}
        </p>
      </details>
    </section>
  );
}
