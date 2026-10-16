import type { ReactElement } from "react";
import type { SkillPropagationSummary, SkillPropagationTarget } from "../../../../shared/skill-propagation-ipc";
import type { TranslationFunction } from "../../../i18n";

export function PropagationDetails({
  summary,
  target,
  t,
}: Readonly<{
  summary: SkillPropagationSummary;
  target?: SkillPropagationTarget;
  t: TranslationFunction;
}>): ReactElement {
  return (
    <details className="propagation-details">
      <summary>{t("canvas.details")}</summary>
      <dl>
        <div>
          <dt>{t("skillManagement.source")}</dt>
          <dd>
            <code>
              {summary.source.sourceId} / {summary.source.packageId} / {summary.source.artifactPath}
            </code>
          </dd>
        </div>
        {target ? (
          <>
            <div>
              <dt>{t("skillManagement.selectedCopyPath")}</dt>
              <dd>
                <code>{target.location.folderPath}</code>
              </dd>
            </div>
            <div>
              <dt>{t("skillManagement.commonBase")}</dt>
              <dd>
                <code>{target.baseRevision?.hash ?? t("skillManagement.notRecorded")}</code>
              </dd>
            </div>
            <div>
              <dt>{t("skillManagement.currentLocal")}</dt>
              <dd>
                <code>{target.localRevision?.hash ?? t("skillManagement.notRecorded")}</code>
              </dd>
            </div>
            <div>
              <dt>{t("skillManagement.source")}</dt>
              <dd>
                <code>{target.sourceRevision?.hash ?? t("skillManagement.notRecorded")}</code>
              </dd>
            </div>
            {target.bindingId ? (
              <div>
                <dt>{t("skillManagement.assignmentBinding")}</dt>
                <dd>
                  <code>{target.bindingId}</code>
                </dd>
              </div>
            ) : null}
          </>
        ) : null}
      </dl>
    </details>
  );
}
