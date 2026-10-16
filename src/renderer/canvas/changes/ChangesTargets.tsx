import type { ReactElement } from "react";
import type { SkillEffectStep, SkillScope } from "../../../shared/skill-management-ipc";
import type { SkillPropagationSummary } from "../../../shared/skill-propagation-ipc";
import { useI18n } from "../../i18n";
import { AdoptionSummary } from "./AdoptionSummary";
import { ResolutionSummary } from "./ResolutionSummary";
import { VariantSummary } from "./VariantSummary";
import { UnboundResolutionSummary } from "./UnboundResolutionSummary";
import { DetachmentSummary } from "./DetachmentSummary";
import { PropagationProjects } from "./propagation/PropagationProjects";
import { buildPropagationView } from "./propagation/view-model";

export function ChangesTargets(
  props: Readonly<{
    scope: SkillScope;
    steps: readonly SkillEffectStep[];
    nameFor: (id: string) => string;
    propagation?: SkillPropagationSummary;
  }>,
): ReactElement {
  const { t } = useI18n();
  if (props.propagation)
    return (
      <PropagationProjects
        summary={props.propagation}
        view={buildPropagationView(props.propagation, props.steps)}
        nameFor={props.nameFor}
        t={t}
        disabled
        onSelect={() => undefined}
      />
    );
  if (props.steps.some((step) => step.detachmentEvidence)) {
    return <DetachmentSummary steps={props.steps} nameFor={props.nameFor} t={t} variant="targets" />;
  }
  const unboundResolution = props.steps.find((step) => step.unboundResolutionEvidence);
  if (unboundResolution) {
    return <UnboundResolutionSummary step={unboundResolution} nameFor={props.nameFor} t={t} variant="targets" />;
  }
  if (props.steps.some((step) => step.resolutionEvidence)) {
    return <ResolutionSummary variant="targets" scope={props.scope} steps={props.steps} nameFor={props.nameFor} />;
  }
  if (props.steps.some((step) => step.plan.kind === "adopt-skill" || step.adoptionEvidence)) {
    return <AdoptionSummary variant="targets" scope={props.scope} steps={props.steps} nameFor={props.nameFor} />;
  }
  const variant = props.steps.find((step) => step.variantCaptureEvidence);
  if (variant) {
    return (
      <section className="changes-reviewed-targets">
        <VariantSummary step={variant} nameFor={props.nameFor} t={t} />
        <p className="changes-note">{t("skillManagement.originalCopyPreserved")}</p>
      </section>
    );
  }
  return (
    <section className="changes-reviewed-targets">
      {props.scope.sourceId ? (
        <p className="changes-note">
          {t("skillManagement.source")}: {props.nameFor(props.scope.sourceId)}
          {props.scope.packageId ? ` / ${props.scope.packageId}` : ""}
        </p>
      ) : null}
      {!props.scope.targets.length ? <p>{t("skillManagement.sourceOnlyTargets")}</p> : null}
      {props.steps
        .filter((step) => step.scope.targets.length)
        .map((step) => (
          <article className="changes-reviewed-target" key={step.stepId}>
            <h3>{[...new Set(step.scope.targets.map((target) => props.nameFor(target.projectId)))].join(", ")}</h3>
            <p className="changes-note">
              {[...new Set(step.scope.targets.map((target) => target.harnessId))].join(" · ")}
            </p>
            <ul>
              {step.files.map((file) => (
                <li key={`${file.rootId}:${file.relativePath}`}>
                  <code>{file.relativePath}</code>
                  <span>
                    {t(
                      file.change === "delete"
                        ? "skillManagement.fileDeleted"
                        : file.change === "add"
                          ? "skillManagement.fileAdded"
                          : file.change === "unchanged"
                            ? "skillManagement.fileUnchanged"
                            : "skillManagement.fileChanged",
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
    </section>
  );
}
