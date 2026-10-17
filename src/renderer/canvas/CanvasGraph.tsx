import { LoadingSkeleton } from "../components/ui/Skeleton";
import { Glossary } from "./Glossary";
import type { ReactElement, ReactNode } from "react";

import type { ProjectSkillGroup, ResourceRecord, ResourceRef } from "../../domain/resource-catalogue";
import { Icon } from "../components/Icon";
import { useI18n, tCount, translateCount, type AppLanguage, type TranslationKey } from "../i18n";
import type {
  CanvasLayout,
  CanvasNode,
  CanvasProjection,
  LogicalSkillNode,
  PositionedNode,
} from "./spatial/spatial-types";
import { CanvasGlyph, type CanvasGlyphName } from "./CanvasGlyph";
import { displayGroupLabel } from "./spatial/canvas-labels";

function nodeKey(ref: ResourceRef): string {
  return JSON.stringify(ref);
}

function iconFor(resource: ResourceRecord): CanvasGlyphName {
  if (resource.state === "unavailable") return "warn";
  if (resource.kind === "project") return "project";
  if (resource.kind === "storefront") return "storefront";
  if (resource.kind === "marketplace") return "marketplace";
  if (resource.kind === "external-source") return "external";
  if (resource.kind === "plugin") return "group";
  return resource.artifactKind === "skill" ? "skill" : "doc";
}

function nodeLabel(node: CanvasNode, t: ReturnType<typeof useI18n>["t"], language: AppLanguage): string {
  return node.kind === "group"
    ? node.missingProjects
      ? tCount("projectView.missingFolders", node.missingProjects.length, {}, language)
      : displayGroupLabel(node, (key) => t(key as TranslationKey))
    : node.kind === "logical-skill"
      ? node.label
      : node.resource.kind === "external-source" && node.resource.ref.entry.id === "external-library"
        ? t("externalLibrary.library")
        : node.resource.kind === "storefront"
          ? t("storefronts.node", { name: node.resource.label })
          : node.resource.kind === "marketplace"
            ? t("canvas.personalMarketplace", { name: node.resource.label })
            : node.resource.label;
}

function groupIcon(node: Extract<CanvasNode, { kind: "group" }>): CanvasGlyphName {
  if (node.category === "managed-plugin") return "group";
  if (node.category === "origin") return "marketplace";
  if (node.category === "individual") return "skill";
  return "doc";
}

function nodeStateLabel(resource: ResourceRecord, t: ReturnType<typeof useI18n>["t"]): string {
  return t(
    resource.state === "observed"
      ? "canvas.observed"
      : resource.state === "unavailable"
        ? "canvas.unavailableState"
        : resource.state === "loading"
          ? "canvas.loadingState"
          : "canvas.unobservedState",
  );
}

function renderNode(
  item: PositionedNode,
  isCenter: boolean,
  inspectedNodeId: string | undefined,
  callbacks: Readonly<{
    onNavigate: (node: Extract<CanvasNode, { kind: "resource" }>) => void;
    onInspect: (node: Extract<CanvasNode, { kind: "resource" }>) => void;
    onOpenSkillCopies: (node: LogicalSkillNode, mode: "document" | "metadata") => void;
    onSelectGroup: (groupId: string | null) => void;
    onDetails: () => void;
    onGroupDetails: (group: ProjectSkillGroup, trigger: HTMLButtonElement) => void;
    onMissingProjects?: (projects: readonly ResourceRecord[]) => void;
  }>,
  t: ReturnType<typeof useI18n>["t"],
  language: AppLanguage,
  metadata?: ReadonlyMap<string, ReactNode>,
): ReactElement {
  const { node, x, y } = item;
  const groupNode = node.kind === "group" ? node : undefined;
  const isGroup = Boolean(groupNode);
  const label = nodeLabel(node, t, language);
  const resourceNode = node.kind === "resource" ? node : undefined;
  const resource = resourceNode?.resource;
  const logicalSkill = node.kind === "logical-skill" ? node : undefined;
  const attention = node.attention;
  const attentionLabel =
    attention?.state === "copy-difference"
      ? t("canvas.copiesDiffer")
      : attention?.state === "local-change"
        ? t("canvas.localSkillChanges")
        : attention?.state === "unavailable"
          ? t("canvas.copyUnavailable")
          : undefined;
  const cue: CanvasGlyphName =
    groupNode?.missingProjects || attention?.state === "copy-difference" || attention?.state === "local-change"
      ? "warn"
      : groupNode
        ? groupIcon(groupNode)
        : logicalSkill
          ? "skill"
          : resource
            ? iconFor(resource)
            : "project";
  return (
    <div
      className={`canvas-node-row${isCenter ? " is-center" : ""}${inspectedNodeId === node.id ? " is-inspected" : ""}`}
      data-tone={cue}
      data-group-id={groupNode?.groupId}
      data-missing-projects={groupNode?.missingProjects ? groupNode.missingProjects.length : undefined}
      data-kind={groupNode ? "group" : logicalSkill ? "artifact" : resource?.kind}
      data-external-library={
        resource?.kind === "external-source" && resource.ref.entry.id === "external-library" ? true : undefined
      }
      data-group-category={groupNode?.category}
      data-label-kind={groupNode?.labelKind}
      data-state={resource?.state}
      data-attention={attention?.state === "quiet" ? undefined : attention?.state}
      data-attention-reasons={attention?.reasons.join(",")}
      data-node-id={node.id}
      data-node-key={
        resource ? nodeKey(resource.ref) : logicalSkill?.members[0] ? nodeKey(logicalSkill.members[0].ref) : undefined
      }
      key={node.id}
      style={{ left: `${x - 132}px`, top: `${y - 36}px` }}
    >
      <button
        aria-label={
          attentionLabel
            ? `${label}, ${attentionLabel}`
            : resource
              ? t("canvas.nodeLabel", { name: label, state: nodeStateLabel(resource, t) })
              : label
        }
        className="canvas-node"
        data-testid={
          resource?.ref.kind === "entry"
            ? `canvas-entry-${resource.ref.entry.kind}-${resource.ref.entry.id}`
            : undefined
        }
        title={label}
        data-group-id={groupNode?.groupId}
        data-group-category={groupNode?.category}
        data-label-kind={groupNode?.labelKind}
        data-kind={groupNode ? "group" : logicalSkill ? "artifact" : resource?.kind}
        data-state={resource?.state}
        data-attention={attention?.state === "quiet" ? undefined : attention?.state}
        data-attention-reasons={attention?.reasons.join(",")}
        onClick={() => {
          if (groupNode?.missingProjects) callbacks.onMissingProjects?.(groupNode.missingProjects);
          else if (groupNode) callbacks.onSelectGroup(isCenter ? null : groupNode.groupId);
          else if (isCenter) callbacks.onDetails();
          else if (logicalSkill)
            callbacks.onOpenSkillCopies(logicalSkill, logicalSkill.members.length ? "document" : "metadata");
          else if (resourceNode) callbacks.onNavigate(resourceNode);
        }}
        type="button"
      >
        <span aria-hidden="true" className="canvas-node-icon">
          <CanvasGlyph name={cue} />
        </span>
        <span className="canvas-node-body">
          <span className="canvas-node-label">{label}</span>
          <span
            className={`canvas-node-meta${resource && metadata?.get(nodeKey(resource.ref)) === t("canvas.notRead") ? " is-faint" : ""}`}
          >
            {resource &&
            resource.kind !== "project" &&
            (resource.state === "loading" || resource.state === "unobserved") &&
            metadata?.get(nodeKey(resource.ref)) === t("canvas.notRead") ? (
              <LoadingSkeleton
                label={t("canvas.loadingSurface", { surface: t("canvas.workspace") })}
                variant="inline"
              />
            ) : (
              ((resource ? metadata?.get(nodeKey(resource.ref)) : undefined) ??
              resource?.description ??
              (resource
                ? t(
                    `canvas.${resource.kind === "marketplace" ? "source" : resource.kind === "external-source" ? "external" : resource.kind === "artifact" ? "artifact" : resource.kind === "project" ? "project" : "plugin"}`,
                  )
                : logicalSkill
                  ? logicalSkill.members
                      .map((member) =>
                        member.location.harnessId === "claude-code"
                          ? "Claude Code"
                          : member.location.harnessId === "codex"
                            ? "Codex"
                            : member.location.harnessId,
                      )
                      .filter((label, index, all) => all.indexOf(label) === index)
                      .join(" · ")
                  : groupNode?.projectSkillGroup?.locations.length
                    ? translateCount(t, "projectView.skillCount", groupNode.projectSkillGroup.locations.length)
                    : ""))
            )}
          </span>
        </span>
      </button>
      {resource?.kind === "external-source" && resource.ref.entry.id === "external-library" ? (
        <Glossary concept="library" appearance="node" />
      ) : resource?.kind === "storefront" ? (
        <Glossary concept="storefront" appearance="node" />
      ) : !isGroup ? (
        <button
          aria-label={t("canvas.info", { name: label })}
          className="canvas-node-info"
          onClick={() => {
            if (logicalSkill) callbacks.onOpenSkillCopies(logicalSkill, "metadata");
            else if (resourceNode) callbacks.onInspect(resourceNode);
          }}
          type="button"
        >
          <Icon name="info" size={14} />
        </button>
      ) : groupNode?.projectSkillGroup ? (
        <button
          aria-label={t("canvas.groupInfo", { name: label })}
          className="canvas-node-info"
          data-testid="canvas-group-info"
          onClick={(event) => callbacks.onGroupDetails(groupNode.projectSkillGroup!, event.currentTarget)}
          type="button"
        >
          <Icon name="info" size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function CanvasGraph(
  props: Readonly<{
    projection: CanvasProjection;
    layout: CanvasLayout;
    metadata?: ReadonlyMap<string, ReactNode>;
    onMissingProjects?: (projects: readonly ResourceRecord[]) => void;
    inspectedNodeId?: string;
    onNavigate: (node: Extract<CanvasNode, { kind: "resource" }>) => void;
    onInspect: (node: Extract<CanvasNode, { kind: "resource" }>) => void;
    onOpenSkillCopies: (node: LogicalSkillNode, mode: "document" | "metadata") => void;
    onSelectGroup: (groupId: string | null) => void;
    onDetails: () => void;
    onGroupDetails: (group: ProjectSkillGroup, trigger: HTMLButtonElement) => void;
  }>,
): ReactElement {
  const { language, t } = useI18n();
  const width = Math.max(800, props.layout.bounds.right - props.layout.bounds.left + 320);
  const height = Math.max(600, props.layout.bounds.bottom - props.layout.bounds.top + 320);
  const left = (props.layout.bounds.left + props.layout.bounds.right - width) / 2;
  const top = (props.layout.bounds.top + props.layout.bounds.bottom - height) / 2;
  const nodes = props.layout.nodes.map((item, index) =>
    renderNode(
      item,
      index === 0 && Boolean(props.projection.center),
      props.inspectedNodeId,
      props,
      t,
      language,
      props.metadata,
    ),
  );
  return (
    <div className="canvas-graph" data-testid="canvas-graph">
      <svg
        aria-hidden="true"
        className="canvas-wires"
        focusable="false"
        style={{ height: `${height}px`, left: `${left}px`, top: `${top}px`, width: `${width}px` }}
        viewBox={`${left} ${top} ${width} ${height}`}
      >
        {props.layout.projectFrame ? (
          <rect
            className="canvas-project-frame"
            data-testid="canvas-project-frame"
            x={props.layout.projectFrame.left}
            y={props.layout.projectFrame.top}
            width={props.layout.projectFrame.right - props.layout.projectFrame.left}
            height={props.layout.projectFrame.bottom - props.layout.projectFrame.top}
            rx={12}
          />
        ) : null}
        {props.layout.wires.map((wire) => (
          <path
            className="canvas-wire"
            d={wire.d}
            data-kind={wire.kind}
            data-wire-id={wire.id}
            data-dashed={wire.dashed || undefined}
            data-attention={wire.attention?.state}
            data-attention-reasons={wire.attention?.reasons.join(",")}
            key={wire.id}
          />
        ))}
        {props.layout.ports.map((port) => (
          <circle className="canvas-port" cx={port.x} cy={port.y} key={`${port.x}:${port.y}`} r={2.5} />
        ))}
      </svg>
      {nodes}
      {props.projection.center && props.projection.children.length === 0 ? (
        <p className="canvas-empty-column" style={{ left: "-132px", top: "52px" }}>
          {t("canvas.noObservedResources")}
        </p>
      ) : null}
    </div>
  );
}
