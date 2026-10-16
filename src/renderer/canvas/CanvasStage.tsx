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
    canvas?: ResourceCanvasProps;
    selection: Readonly<{ ref: ResourceRef; relativePath?: string }> | null;
    viewportRef: RefObject<HTMLDivElement | null>;
    camera: CameraControls;
    onSetup: (intent: "marketplace" | "project" | "agents", opener: HTMLElement) => void;
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
      className={`canvas-stage${props.contextIsWorkspace ? " is-workspace" : ""}`}
      inert={props.setupApplying || props.canvasOverlayOpen}
    >
      <div className="canvas-stage-heading">
        <p className="stage-title">{props.contextIsWorkspace ? t("canvas.workspace") : props.currentLabel}</p>
        <span>
          {props.contextIsWorkspace && props.listing.status === "unavailable"
            ? null
            : props.listing.status === "partial"
              ? props.contextIsWorkspace && observationLocations.length === 0
                ? t("canvas.loading")
                : `${t("canvas.partial")}${props.contextIsWorkspace ? ` ${observationLocations.join("; ")}` : ""}`
              : props.listing.status === "loading" ||
                  (props.contextIsWorkspace && props.listing.status === "unobserved")
                ? t("canvas.loading")
                : props.listing.status === "unobserved"
                  ? t("canvas.unobserved")
                  : props.listing.status === "unavailable"
                    ? t("canvas.unavailable")
                    : null}
        </span>
      </div>
      {props.contextIsWorkspace && props.listing.children.length === 0 ? (
        <section className="canvas-setup-empty" data-testid="canvas-setup-empty-state">
          <h1>{t("canvasSetup.emptyTitle")}</h1>
          <p>{t("canvasSetup.emptyDescription")}</p>
          <div className="canvas-setup-actions">
            <button
              data-testid="canvas-setup-empty-marketplace"
              disabled={!props.setupAvailable}
              onClick={(event) => props.onSetup("marketplace", event.currentTarget)}
              title={!props.setupAvailable ? t("canvasSetup.apiUnavailable") : undefined}
              type="button"
            >
              {t("canvasSetup.addMarketplace")}
            </button>
            <button
              className="is-secondary"
              data-testid="canvas-setup-empty-project"
              disabled={!props.setupAvailable}
              onClick={(event) => props.onSetup("project", event.currentTarget)}
              title={!props.setupAvailable ? t("canvasSetup.apiUnavailable") : undefined}
              type="button"
            >
              {t("canvasSetup.addProject")}
            </button>
            <button
              className="is-secondary"
              data-testid="canvas-setup-empty-agents"
              disabled={!props.setupAvailable}
              onClick={(event) => props.onSetup("agents", event.currentTarget)}
              type="button"
            >
              {t("canvasSetup.connectAgents")}
            </button>
          </div>
          {!props.setupAvailable ? <p className="canvas-setup-unavailable">{t("canvasSetup.apiUnavailable")}</p> : null}
        </section>
      ) : null}
      {props.contextIsWorkspace || props.listing.center ? (
        <CanvasViewport
          controls={props.camera}
          disabled={props.setupApplying || props.comparisonOpen}
          viewportRef={props.viewportRef}
        >
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
