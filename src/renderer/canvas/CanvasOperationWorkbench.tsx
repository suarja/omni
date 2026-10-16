import { activeWorkshop } from "../../domain/source-roles";
import { NewSkillSheet } from "./NewSkillSheet";
import type { ReactElement } from "react";

import { ChangesWorkbench } from "./changes/ChangesWorkbench";
import type { useAssignmentChoices } from "./changes/use-assignment-choices";
import type { useCanvasChanges } from "./use-canvas-changes";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import { skillVariantDestinations } from "./skill-variant-destinations";

type Props = Readonly<{
  assignmentChoices: ReturnType<typeof useAssignmentChoices>;
  canvas: ResourceCanvasProps;
  changes: ReturnType<typeof useCanvasChanges>;
  onApplyingChange: (active: boolean) => void;
  onConnectAgent?: (opener: HTMLElement) => void;
  packageId?: string;
  onOpenVariant?: (source: SourceSkillRef) => void | Promise<void>;
  suppress?: boolean;
}>;

export function CanvasOperationWorkbench(props: Props): ReactElement | null {
  const { assignmentChoices, canvas, changes } = props;
  if (!changes.open || props.suppress) return null;
  if (
    changes.journey === "draft" &&
    !changes.request &&
    !changes.skillIntent &&
    !changes.skillIntentId &&
    !changes.resultId &&
    !changes.restoreOperationId &&
    !changes.removalBindingIds &&
    !changes.managedResolution
  )
    return (
      <NewSkillSheet
        canvas={canvas}
        initialPackageId={changes.packageId ?? props.packageId}
        onClose={changes.close}
        onApplyingChange={props.onApplyingChange}
      />
    );
  const contextEntry = canvas.context.kind === "workspace" ? null : canvas.context.entry;
  return (
    <ChangesWorkbench
      api={canvas.api}
      artifacts={assignmentChoices.artifacts}
      initialRequest={changes.request}
      initialSkillIntent={changes.skillIntent}
      initialSkillIntentId={changes.skillIntentId}
      initialManagedResolution={changes.managedResolution}
      initialRemovalBindingIds={changes.removalBindingIds}
      initialRestoreOperationId={changes.restoreOperationId}
      initialResultId={changes.resultId}
      initialJourney={changes.journey}
      initialProjectId={changes.projectId}
      onClose={changes.close}
      onBack={changes.skillIntent?.kind === "reconcile" || changes.managedResolution ? changes.close : undefined}
      onSourceChanged={canvas.onRefresh}
      onAdoptionChanged={canvas.onRefreshSkillAdoption}
      onApplyingChange={props.onApplyingChange}
      onOpenVariant={props.onOpenVariant}
      onConnectAgent={props.onConnectAgent}
      packageId={changes.request?.packageId ?? changes.packageId ?? props.packageId}
      packages={assignmentChoices.packages}
      projects={assignmentChoices.projects}
      requestId={changes.requestId}
      sourceId={
        changes.request?.sourceId ?? changes.sourceId ?? (contextEntry?.kind === "source" ? contextEntry.id : undefined)
      }
      sources={[activeWorkshop(canvas.snapshot.registry)]
        .filter((source) => source !== undefined)
        .map((source) => ({ id: source.ref.id, name: source.displayName }))}
      variantDestinations={skillVariantDestinations(canvas.snapshot)}
    />
  );
}
