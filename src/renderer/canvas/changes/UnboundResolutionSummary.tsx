import { harnessLabel } from "../project-view-model";
import type { ReactElement } from "react";

import type { SkillEffectStep } from "../../../shared/skill-management-ipc";
import type { TranslationFunction } from "../../i18n";

export function UnboundResolutionSummary(
  props: Readonly<{
    step: SkillEffectStep;
    nameFor: (id: string) => string;
    t: TranslationFunction;
    variant: "diff" | "targets";
  }>,
): ReactElement | null {
  const evidence = props.step.unboundResolutionEvidence;
  if (!evidence) return null;
  const source = evidence.source.ref;
  const location = evidence.local.location;
  const restoring = props.step.plan.kind === "restore-apply";
  const bindingId = props.step.bindingEffects[0]?.bindingId;

  return (
    <section aria-label={props.t("skillManagement.canonicalLinkReview")} className="changes-unbound-summary">
      <h3>{props.t(restoring ? "skillManagement.restoreReview" : "skillManagement.canonicalLinkReview")}</h3>
      <dl>
        <div>
          <dt>{props.t("skillManagement.canonicalSource")}</dt>
          <dd>
            {props.nameFor(source.sourceId)} · {source.packageId} / {source.artifactPath}
          </dd>
        </div>
        <div>
          <dt>{props.t("skillManagement.selectedCopy")}</dt>
          <dd>
            {props.nameFor(location.projectId)} · {harnessLabel(location.harnessId)} ·{" "}
            <code>{location.folderPath}</code>
          </dd>
        </div>
        <div>
          <dt>{props.t("skillManagement.historicalCommonBase")}</dt>
          <dd>{props.t("skillManagement.historicalBaseUnknown")}</dd>
        </div>
      </dl>
      <p>{props.t(restoring ? "skillManagement.unboundRestoreScope" : "skillManagement.unboundLinkScope")}</p>
      <details>
        <summary>{props.t("canvas.details")}</summary>
        <dl>
          <div>
            <dt>{props.t("skillManagement.skillId")}</dt>
            <dd>
              <code>{evidence.skillId}</code>
            </dd>
          </div>
          <div>
            <dt>{props.t("skillManagement.sourceId")}</dt>
            <dd>
              <code>{source.sourceId}</code>
            </dd>
          </div>
          {bindingId ? (
            <div>
              <dt>{props.t("skillManagement.assignmentBinding")}</dt>
              <dd>
                <code>{bindingId}</code>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{props.t("skillManagement.storeRevision")}</dt>
            <dd>{evidence.storeRevision}</dd>
          </div>
        </dl>
      </details>
      {props.variant === "targets" ? <p>{props.t("skillManagement.otherCopiesRemainUnchanged")}</p> : null}
    </section>
  );
}
