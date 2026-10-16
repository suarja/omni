import { harnessLabel } from "../project-view-model";
import type { ReactElement } from "react";

import type { SkillEffectStep, SkillScope } from "../../../shared/skill-management-ipc";
import { useI18n } from "../../i18n";

export function ResolutionSummary(
  props: Readonly<{
    variant: "diff" | "targets";
    scope: SkillScope;
    steps: readonly SkillEffectStep[];
    nameFor: (id: string) => string;
  }>,
): ReactElement {
  const { t } = useI18n();
  const steps = props.steps.filter((step) => step.resolutionEvidence);
  return (
    <section
      aria-label={t("skillManagement.resolutionReview")}
      className={`changes-resolution-summary is-${props.variant}`}
    >
      {steps.map((step) => {
        const evidence = step.resolutionEvidence!;
        const restoring = step.plan.kind === "restore-apply";
        const keepLocal = evidence.choice === "keep-local";
        return (
          <article className="changes-resolution-effect" key={step.stepId}>
            <h3>
              {t(
                restoring
                  ? "skillManagement.restoreReview"
                  : keepLocal
                    ? "skillManagement.keepLocal"
                    : "skillManagement.useCanonical",
              )}
            </h3>
            <p>
              {props.nameFor(evidence.local.location.projectId)} · {harnessLabel(evidence.local.location.harnessId)}
            </p>
            <code>{evidence.local.location.folderPath}</code>
            {props.scope.sourceId ? (
              <p className="changes-note">
                {t("skillManagement.source")}: {props.nameFor(props.scope.sourceId)}
                {props.scope.packageId ? ` / ${props.scope.packageId}` : ""}
                {props.scope.artifactPath ? ` / ${props.scope.artifactPath}` : ""}
              </p>
            ) : null}
            {keepLocal ? <p className="changes-note">{t("skillManagement.keepLocalDescription")}</p> : null}
            <details className="changes-resolution-details">
              <summary>{t("canvas.details")}</summary>
              <dl>
                {evidence.sourceTree ? (
                  <div>
                    <dt>{t("skillManagement.canonicalTreeEvidence")}</dt>
                    <dd>
                      {evidence.sourceTree.revision.files.length} files ·{" "}
                      <code>{evidence.sourceTree.revision.hash}</code>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t("skillManagement.baseTransition")}</dt>
                  <dd>
                    <code>
                      {step.metadataEffects?.[0]?.before?.baseRevisionId ?? evidence.base.baseRevisionId} →{" "}
                      {step.metadataEffects?.[0]?.after?.baseRevisionId ?? evidence.base.baseRevisionId}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>{t("skillManagement.assignmentBinding")}</dt>
                  <dd>
                    <code>{evidence.use.bindingId}</code>
                  </dd>
                </div>
              </dl>
            </details>
            {props.variant === "targets" ? (
              <>
                <p className="changes-note">{t("skillManagement.selectedCopyOnly")}</p>
                <p className="changes-note">{t("skillManagement.otherCopiesRemainUnchanged")}</p>
              </>
            ) : !keepLocal && !step.files.length ? (
              <p className="changes-note">
                {t(restoring ? "skillManagement.noFileRestoreNeeded" : "skillManagement.noCanonicalFileChanges")}
              </p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
