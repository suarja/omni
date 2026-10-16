import { harnessLabel } from "../project-view-model";
import type { ReactElement } from "react";

import type { SkillEffectStep } from "../../../shared/skill-management-ipc";
import type { TranslationFunction } from "../../i18n";

export function DetachmentSummary(
  props: Readonly<{
    steps: readonly SkillEffectStep[];
    nameFor: (id: string) => string;
    t: TranslationFunction;
    variant: "diff" | "targets";
  }>,
): ReactElement {
  const steps = props.steps.filter((step) => step.detachmentEvidence);
  return (
    <section
      aria-label={props.t("skillManagement.detachmentEffects")}
      className={`changes-adoption-summary changes-detachment-summary is-${props.variant}`}
    >
      {props.variant === "diff" ? (
        <p className="changes-adoption-no-files">{props.t("skillManagement.detachmentNoFileChanges")}</p>
      ) : null}
      {steps.map((step) => {
        const evidence = step.detachmentEvidence!;
        const restoring = Boolean(step.detachmentRestoreOrigin);
        const { location } = evidence.local;
        const otherLocations = evidence.record.locations.filter(
          (candidate) =>
            candidate.projectId !== location.projectId ||
            candidate.harnessId !== location.harnessId ||
            candidate.folderPath !== location.folderPath,
        );
        return (
          <article className="changes-adoption-effect changes-detachment-effect" key={step.stepId}>
            <h3>
              {props.nameFor(location.projectId)} · {harnessLabel(location.harnessId)}
            </h3>
            <code>{location.folderPath}</code>
            <p className="changes-note">
              {props.t(restoring ? "skillManagement.detachmentUseRestored" : "skillManagement.detachmentUseRemoved")}
            </p>
            <p className="changes-note">
              {props.t(
                restoring ? "skillManagement.detachmentBindingRestored" : "skillManagement.detachmentBindingRemoved",
              )}
            </p>
            <p className="changes-note">{props.t("skillManagement.detachmentBaseRetained")}</p>
            <p className="changes-note">
              {otherLocations.length
                ? props.t("skillManagement.detachmentPeersRetained")
                : props.t("skillManagement.detachmentIdentityRetained")}
            </p>
            <details>
              <summary>{props.t("canvas.details")}</summary>
              <dl>
                <div>
                  <dt>{props.t("skillManagement.sourceSkill")}</dt>
                  <dd>
                    {props.nameFor(evidence.use.source.sourceId)} · {evidence.use.source.packageId} /{" "}
                    {evidence.use.source.artifactPath}
                  </dd>
                </div>
                <div>
                  <dt>{props.t("skillManagement.skillId")}</dt>
                  <dd>
                    <code>{evidence.skillId}</code>
                  </dd>
                </div>
                <div>
                  <dt>{props.t("skillManagement.assignmentBinding")}</dt>
                  <dd>
                    <code>{evidence.binding.bindingId}</code>
                  </dd>
                </div>
                <div>
                  <dt>{props.t("skillManagement.commonRestoreBase")}</dt>
                  <dd>
                    <code>{evidence.base.baseRevisionId}</code> · <code>{evidence.base.revision.hash}</code>
                  </dd>
                </div>
                <div>
                  <dt>{props.t("skillManagement.storeRevision")}</dt>
                  <dd>{evidence.storeRevision}</dd>
                </div>
                <div>
                  <dt>{props.t("skillManagement.detachmentRetainedLocations")}</dt>
                  <dd>{evidence.record.locations.length}</dd>
                </div>
              </dl>
            </details>
          </article>
        );
      })}
    </section>
  );
}
