import type { ReactElement } from "react";
import type { ResourceCanvasProps } from "../resource-canvas-types";
import { ChangesWorkbench } from "../changes/ChangesWorkbench";
import { useCanvasRail } from "../rail/rail-context";
import { projectHarnesses } from "../project-view-model";
import { routeForCanvasPage } from "./page-navigation";
import { isActiveAvailableProject } from "./active-projects";

export function SavedPageOperation(
  props: ResourceCanvasProps & Readonly<{ onApplyingChange: (busy: boolean) => void }>,
): ReactElement | null {
  const rail = useCanvasRail()!;
  const id = props.initialSkillResultId ?? props.initialSkillRestoreOperationId;
  if (!id || !props.canvasPage) return null;
  return (
    <ChangesWorkbench
      key={id}
      api={props.api}
      initialJourney="assign"
      initialResultId={props.initialSkillResultId}
      initialRestoreOperationId={props.initialSkillRestoreOperationId}
      sources={(rail.externalLibrary.list?.sources ?? []).map((source) => ({ id: source.id, name: source.name }))}
      packages={[]}
      artifacts={[]}
      projects={props.snapshot.registry.projects.filter(isActiveAvailableProject).map((project) => ({
        id: project.ref.id,
        name: project.displayName,
        available: true,
        harnesses: projectHarnesses,
      }))}
      onClose={() => props.onNavigate(routeForCanvasPage(props.canvasPage!))}
      onSourceChanged={props.onRefresh}
      onAdoptionChanged={rail.externalLibrary.reload}
      onApplyingChange={props.onApplyingChange}
    />
  );
}
