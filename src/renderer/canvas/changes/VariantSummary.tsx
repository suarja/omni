import type { ReactElement } from "react";

import type { SkillEffectStep } from "../../../shared/skill-management-ipc";
import type { TranslationFunction } from "../../i18n";

export function VariantSummary(
  props: Readonly<{
    step: SkillEffectStep;
    nameFor: (id: string) => string;
    t: TranslationFunction;
  }>,
): ReactElement | null {
  const evidence = props.step.variantCaptureEvidence;
  if (!evidence) return null;
  const location = evidence.request.locations[0]!;
  const restoring = props.step.plan.kind === "restore-apply";
  return (
    <section aria-label={props.t("skillManagement.captureEffects")} className="changes-variant-summary">
      <h3>{props.t(restoring ? "skillManagement.restoreReview" : "skillManagement.captureEffects")}</h3>
      <dl>
        <div>
          <dt>{props.t("skillManagement.personalSource")}</dt>
          <dd>
            {props.nameFor(evidence.destination.source.sourceId)} · {evidence.destination.source.packageId}
          </dd>
        </div>
        <div>
          <dt>{props.t("skillManagement.variantDestination")}</dt>
          <dd>
            <code>{evidence.destination.source.artifactPath}</code>
          </dd>
        </div>
        <div>
          <dt>{props.t("skillManagement.capturedFrom")}</dt>
          <dd>
            {props.nameFor(location.projectId)} · {location.harnessId} · <code>{location.folderPath}</code>
          </dd>
        </div>
      </dl>
      <details>
        <summary>{props.t("skillManagement.variantOrigin")}</summary>
        <dl>
          <div>
            <dt>{props.t("skillManagement.variantOrigin")}</dt>
            <dd>
              <code>{evidence.origin.variantId}</code> · {props.t("skillManagement.forkOf")}{" "}
              <code>{evidence.origin.forkOf}</code>
            </dd>
          </div>
        </dl>
      </details>
      <p>
        {props.t(
          evidence.use
            ? "skillManagement.managedVariantPreservesUse"
            : "skillManagement.unmanagedVariantCreatesNoBinding",
        )}
      </p>
    </section>
  );
}
