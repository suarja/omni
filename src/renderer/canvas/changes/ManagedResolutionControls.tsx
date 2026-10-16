import type { ReactElement } from "react";

import type { SkillManagedResolutionChoice } from "../../../shared/skill-reconciliation-request";
import type { SkillIntent } from "../../../shared/skill-management-ipc";
import type { ManagedResolutionSelection } from "../use-canvas-changes";
import type { SkillVariantDestination } from "../skill-variant-destinations";
import { SkillVariantCaptureControls } from "../SkillVariantCaptureControls";
import { useI18n } from "../../i18n";
import { ResolutionChoices } from "./ResolutionChoices";

type ResolutionChoice = SkillManagedResolutionChoice | "keep-variant";

export function ManagedResolutionControls(
  props: Readonly<{
    selection?: ManagedResolutionSelection;
    value?: ResolutionChoice;
    disabled: boolean;
    reviewed?: boolean;
    canReview: boolean;
    destinations: readonly SkillVariantDestination[];
    projectName: string;
    onChange: (choice: ResolutionChoice) => void;
    onReviewCapture: (intent: Extract<SkillIntent, { kind: "reconcile" }>) => void;
    onSelectionChanged: () => void;
  }>,
): ReactElement | null {
  const { t } = useI18n();
  const selection = props.selection;
  if (!selection) return null;
  return (
    <details className="changes-resolution-configuration" open={!props.reviewed}>
      <summary>{t("skillManagement.resolutionChoice")}</summary>
      <ResolutionChoices value={props.value} disabled={props.disabled} includeVariant onChange={props.onChange} />
      {props.value === "keep-variant" ? (
        <SkillVariantCaptureControls
          canReview={props.canReview}
          destinations={props.destinations}
          label={selection.location.folderPath.split("/").at(-1) ?? "personal-copy"}
          location={selection.location}
          onReview={props.onReviewCapture}
          onSelectionChanged={props.onSelectionChanged}
          projectName={props.projectName}
          skillId={selection.skillId}
        />
      ) : null}
    </details>
  );
}
