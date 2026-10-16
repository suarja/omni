import { AppUpdateNotification } from "../settings/AppUpdateRow";
import { PagesCanvas } from "./pages/PagesCanvas";
import { CanvasToastProvider } from "./CanvasToast";
import type { ReactElement } from "react";
import { CanvasRailProvider } from "./rail/rail-context";
import { ProjectCanvas } from "./ProjectCanvas";
import { ResourceCanvasContent } from "./ResourceCanvasContent";
import type { ResourceCanvasProps } from "./resource-canvas-types";

export type { ResourceCanvasProps } from "./resource-canvas-types";

export function ResourceCanvas(props: ResourceCanvasProps): ReactElement {
  const projectId =
    props.context.kind === "entry" && props.context.entry.kind === "project" ? props.context.entry.id : undefined;
  const operationRoute =
    props.initialSkillIntent ||
    props.initialSkillRequest ||
    props.initialSkillRestoreOperationId ||
    props.initialSkillResultId ||
    props.initialSkillCopy;
  return (
    <CanvasToastProvider>
      <AppUpdateNotification api={props.railServices?.api ?? props.api} />
      <CanvasRailProvider canvas={props}>
        {props.canvasPage ? (
          <PagesCanvas {...props} />
        ) : projectId && props.api?.readProjectSkills && !operationRoute ? (
          <ProjectCanvas key={projectId} {...props} projectId={projectId} />
        ) : (
          <ResourceCanvasContent {...props} />
        )}
      </CanvasRailProvider>
    </CanvasToastProvider>
  );
}
