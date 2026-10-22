import { WorkspaceDeliveryStatus } from "./delivery/WorkspaceDeliveryStatus";
import { CanvasLoadingSkeleton } from "./CanvasLoadingSkeleton";
import { WorkspaceSetupHeader, WorkspaceSetupMap, type WorkspaceMapIntent } from "./setup/WorkspaceSetupMap";
import type { WorkspaceMapState } from "./setup/use-workspace-map";
import type { WorkspaceMapGeometry } from "./setup/workspace-map-layout";
import { useEmptyCanvasPress } from "./use-empty-canvas-press";
import { workspaceObservationLocations } from "./rail/workspace-relations";
import { useState, type RefObject, type ReactElement } from "react";

import type { ProjectSkillGroup, ResourceListing, ResourceRef, ResourceRecord } from "../../domain/resource-catalogue";
import { useWorkspaceNodeMetadata } from "./use-workspace-node-metadata";
import { MissingProjectsSheet } from "./MissingProjectsSheet";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import { CanvasGraph } from "./CanvasGraph";
import { CanvasViewport } from "./spatial/CanvasViewport";
import type { CameraControls } from "./spatial/use-canvas-camera";
import {
  resourceNodeId,
  type CanvasLayout,
  type CanvasNode,
  type CanvasProjection,
  type LogicalSkillNode,
} from "./spatial/spatial-types";

type ResourceNode = Extract<CanvasNode, { kind: "resource" }>;

export function CanvasStage(
  props: Readonly<{
    onEmptyPress?: () => void;
    contextIsWorkspace: boolean;
    listing: ResourceListing;
    currentLabel: string;
    setupAvailable: boolean;
    setupApplying: boolean;
    canvasOverlayOpen: boolean;
    comparisonOpen: boolean;
    projection: CanvasProjection;
    layout: CanvasLayout;
    workspaceMap?: WorkspaceMapState;
    mapGeometry?: WorkspaceMapGeometry;
    canvas?: ResourceCanvasProps;
    selection: Readonly<{ ref: ResourceRef; relativePath?: string }> | null;
    viewportRef: RefObject<HTMLDivElement | null>;
    camera: CameraControls;
    onSetup: (intent: WorkspaceMapIntent, opener: HTMLElement) => void;
    onSelectGroup: (groupId: string | null) => void;
    onGroupDetails: (group: ProjectSkillGroup, opener: HTMLButtonElement) => void;
    onOpenSkillCopies: (node: LogicalSkillNode, tab: "document" | "metadata") => void;
    onDetails: () => void;
    onInspect: (node: ResourceNode) => void;
    onNavigate: (node: ResourceNode) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const metadata = useWorkspaceNodeMetadata(props.canvas, props.contextIsWorkspace);
  const observationLocations =
    props.contextIsWorkspace && props.canvas ? workspaceObservationLocations(props.canvas.snapshot) : [];
  const hasMap = Boolean(props.contextIsWorkspace && props.mapGeometry?.center);
  const mapVisible = Boolean(hasMap && !props.workspaceMap?.hidden && (props.workspaceMap?.progress.count ?? 0) < 3);
  const mapLoading = Boolean(props.canvas?.registryLoading || props.workspaceMap?.loading);
  const [missing, setMissing] = useState<readonly ResourceRecord[] | null>(null);
  const emptyPress = useEmptyCanvasPress(() => {
    setMissing(null);
    props.onEmptyPress?.();
  }, props.setupApplying || props.canvasOverlayOpen);
  const inspectedNodeId = props.selection
    ? (props.projection.groups
        .flatMap((group) => group.children)
        .find(
          (node) =>
            node.kind === "logical-skill" &&
            node.members.some(
              (member) =>
                JSON.stringify(member.ref) === JSON.stringify(props.selection!.ref) &&
                `${member.location.folderPath}/SKILL.md` === props.selection!.relativePath,
            ),
        )?.id ?? resourceNodeId(props.selection.ref, props.selection.relativePath))
    : undefined;

  return (
    <main
      {...emptyPress}
      className={`canvas-stage${props.contextIsWorkspace ? " is-workspace" : ""}${hasMap ? " has-workspace-map" : ""}`}
      inert={props.setupApplying || props.canvasOverlayOpen}
    >
      {!mapVisible || props.listing.status === "partial" ? (
        <div className="canvas-stage-heading">
          {!mapVisible ? (
            <p className="stage-title">{props.contextIsWorkspace ? t("canvas.workspace") : props.currentLabel}</p>
          ) : null}
          <span>
            {props.listing.status === "partial" && observationLocations.length
              ? `${t("canvas.partial")} ${observationLocations.join("; ")}`
              : !props.contextIsWorkspace && props.listing.status === "unavailable"
                ? t("canvas.unavailable")
                : null}
          </span>
        </div>
      ) : null}
      {mapVisible && !mapLoading && props.workspaceMap ? (
        <WorkspaceSetupHeader
          state={props.workspaceMap}
          onFocusStep={() => {
            props.camera.fit();
            props.viewportRef.current
              ?.querySelector<HTMLElement>(`[data-setup-step="${props.workspaceMap?.progress.current}"]`)
              ?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {props.contextIsWorkspace && props.workspaceMap?.error ? (
        <p className="workspace-setup-error" role="alert">
          {t("canvasSetup.setupStateUnavailable")}
        </p>
      ) : null}
      {props.contextIsWorkspace ? <WorkspaceDeliveryStatus /> : null}
      {mapVisible && !mapLoading && !props.setupAvailable ? (
        <p className="workspace-setup-unavailable">{t("canvasSetup.apiUnavailable")}</p>
      ) : null}
      {props.contextIsWorkspace || props.listing.center ? (
        <CanvasViewport
          controls={props.camera}
          disabled={props.setupApplying || props.comparisonOpen}
          viewportRef={props.viewportRef}
        >
          {props.canvas?.registryLoading && !props.listing.children.length && !props.mapGeometry ? (
            <CanvasLoadingSkeleton label={t("canvas.loadingSurface", { surface: t("canvas.workspace") })} />
          ) : null}
          {props.mapGeometry && props.workspaceMap ? (
            <WorkspaceSetupMap
              state={props.workspaceMap}
              geometry={props.mapGeometry}
              loading={mapLoading}
              available={props.setupAvailable}
              onSetup={props.onSetup}
            />
          ) : null}
          <CanvasGraph
            projection={props.projection}
            layout={props.layout}
            metadata={metadata}
            onMissingProjects={setMissing}
            inspectedNodeId={inspectedNodeId}
            onSelectGroup={props.onSelectGroup}
            onGroupDetails={props.onGroupDetails}
            onOpenSkillCopies={props.onOpenSkillCopies}
            onDetails={props.onDetails}
            onInspect={props.onInspect}
            onNavigate={props.onNavigate}
          />
        </CanvasViewport>
      ) : (
        <div className="canvas-empty-state">
          <Icon name="question" size={20} />
          <p>{t("canvas.empty")}</p>
        </div>
      )}
      {missing && props.canvas ? (
        <MissingProjectsSheet projects={missing} canvas={props.canvas} onClose={() => setMissing(null)} />
      ) : null}
    </main>
  );
}
