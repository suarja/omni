import { useState, type ReactElement } from "react";
import type { SkillEffectStep } from "../../../shared/skill-management-ipc";
import type { SkillPropagationSummary } from "../../../shared/skill-propagation-ipc";
import type { TranslationFunction } from "../../i18n";
import { filesFor } from "./operation-view-model";
import { FileChange } from "./FileChange";
import { AdoptionSummary } from "./AdoptionSummary";
import { ResolutionSummary } from "./ResolutionSummary";
import { VariantSummary } from "./VariantSummary";
import { UnboundResolutionSummary } from "./UnboundResolutionSummary";
import { DetachmentSummary } from "./DetachmentSummary";
import { PropagationCompare } from "./propagation/PropagationCompare";
import { buildPropagationView } from "./propagation/view-model";

export function ChangesDiff({
  steps,
  t,
  nameFor = (id) => id,
  propagation,
}: Readonly<{
  steps: readonly SkillEffectStep[];
  t: TranslationFunction;
  nameFor?: (id: string) => string;
  propagation?: SkillPropagationSummary;
}>): ReactElement {
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  if (propagation)
    return (
      <PropagationCompare
        summary={propagation}
        view={buildPropagationView(propagation, steps)}
        nameFor={nameFor}
        t={t}
      />
    );
  const resolution = steps.find((step) => step.resolutionEvidence);
  const unboundResolution = steps.find((step) => step.unboundResolutionEvidence);
  const variant = steps.find((step) => step.variantCaptureEvidence);
  const variantSummary = variant ? <VariantSummary step={variant} nameFor={nameFor} t={t} /> : null;
  const summary = resolution ? (
    <ResolutionSummary variant="diff" scope={resolution.scope} steps={steps} nameFor={nameFor} />
  ) : null;
  const unboundSummary = unboundResolution ? (
    <UnboundResolutionSummary step={unboundResolution} nameFor={nameFor} t={t} variant="diff" />
  ) : null;
  if (steps.some((step) => step.detachmentEvidence)) {
    return <DetachmentSummary steps={steps} nameFor={nameFor} t={t} variant="diff" />;
  }
  if (steps.some((step) => step.plan.kind === "adopt-skill" || step.adoptionEvidence)) {
    return <AdoptionSummary variant="diff" scope={steps[0]!.scope} steps={steps} nameFor={nameFor} />;
  }
  const files = filesFor(steps);
  if (!files.length)
    return (
      <>
        {variantSummary}
        {unboundSummary}
        {summary ?? (unboundSummary ? null : <p className="changes-empty">{t("skillManagement.emptyDiff")}</p>)}
      </>
    );
  return (
    <div data-testid="changes-diff">
      {variantSummary}
      {unboundSummary}
      {summary}
      <div className="changes-diff-toolbar">
        <span>{t("skillManagement.reviewedFiles")}</span>
        <div role="group" aria-label={t("skillManagement.diffLayout")}>
          <button aria-pressed={layout === "unified"} onClick={() => setLayout("unified")} type="button">
            {t("skillManagement.unified")}
          </button>
          <button aria-pressed={layout === "split"} onClick={() => setLayout("split")} type="button">
            {t("skillManagement.split")}
          </button>
        </div>
      </div>
      <div className="changes-file-list">
        {files.map((file) => (
          <FileChange
            key={`${file.rootId}:${file.relativePath}`}
            file={file}
            layout={layout}
            rootName={nameFor(file.rootId)}
            local={steps.some((step) => step.scope.targets.some((target) => target.projectId === file.rootId))}
            commonBaseHash={
              resolution?.resolutionEvidence?.base.revision.files.find(
                (entry) =>
                  `${resolution.resolutionEvidence!.local.location.folderPath}/${entry.path}` === file.relativePath,
              )?.hash
            }
            t={t}
          />
        ))}
      </div>
    </div>
  );
}
