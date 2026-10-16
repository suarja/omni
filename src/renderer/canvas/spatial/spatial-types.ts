import type { ProjectSkillGroup, ResourceRecord, ResourceRef } from "../../../domain/resource-catalogue";
import type { SkillAttentionSummary } from "../../../domain/skill-reconciliation/attention";
import type {
  LogicalSkillRecord,
  SkillCopyLocationRead,
  SkillMember,
} from "../../../domain/skill-reconciliation/types";

export type Camera = Readonly<{ x: number; y: number; scale: number }>;
export type Point = Readonly<{ x: number; y: number }>;
export type Size = Readonly<{ width: number; height: number }>;
export type Bounds = Readonly<{ left: number; top: number; right: number; bottom: number }>;
export type CanvasProjectAttention = SkillAttentionSummary &
  Readonly<{
    projectId: string;
    rootKey: string;
    observationKey: string;
    freshness: "fresh" | "failed";
    observedAt: string;
  }>;

export type CanvasNode =
  | Readonly<{
      kind: "resource";
      id: string;
      resource: ResourceRecord;
      relativePath?: string;
      attention?: SkillAttentionSummary;
    }>
  | Readonly<{
      kind: "logical-skill";
      id: string;
      skillId: string;
      label: string;
      groupId: string;
      record: LogicalSkillRecord;
      members: readonly SkillMember[];
      locations: readonly SkillCopyLocationRead[];
      attention: SkillAttentionSummary;
    }>
  | Readonly<{
      kind: "group";
      id: string;
      groupId: string;
      label: string;
      labelKind?: "literal";
      category?: ProjectSkillGroup["category"];
      projectSkillGroup?: ProjectSkillGroup;
      missingProjects?: readonly ResourceRecord[];
      attention?: SkillAttentionSummary;
    }>;
export type LogicalSkillNode = Extract<CanvasNode, { kind: "logical-skill" }>;
export type CanvasGroup = Readonly<{
  id: string;
  label: string;
  labelKind?: "literal";
  category?: ProjectSkillGroup["category"];
  projectSkillGroup?: ProjectSkillGroup;
  children: readonly CanvasNode[];
  attention?: SkillAttentionSummary;
}>;
export type CanvasRelation = Readonly<{
  from: string;
  to: string;
  kind: "contains" | "desired-use" | "publication";
  attention?: SkillAttentionSummary;
}>;
export type CanvasProjection = Readonly<{
  key: string;
  center?: CanvasNode;
  children: readonly CanvasNode[];
  groups: readonly CanvasGroup[];
  relations: readonly CanvasRelation[];
}>;
export type PositionedNode = Readonly<{ node: CanvasNode; x: number; y: number }>;
export type CanvasLayout = Readonly<{
  nodes: readonly PositionedNode[];
  bounds: Bounds;
  wires: readonly Readonly<{
    id: string;
    d: string;
    kind?: CanvasRelation["kind"];
    attention?: SkillAttentionSummary;
  }>[];
  ports: readonly Point[];
}>;
export type CanvasViewState = Readonly<{
  groupId: string | null;
  cameras: Readonly<Record<string, Camera>>;
  selection?: Readonly<{ ref: ResourceRef; relativePath?: string }>;
}>;
export type CanvasSession = Readonly<{
  read(key: string): CanvasViewState | undefined;
  write(key: string, state: CanvasViewState): void;
  readProjectAttention(projectId: string): CanvasProjectAttention | undefined;
  writeProjectAttention(attention: CanvasProjectAttention): void;
  listProjectAttention(): readonly CanvasProjectAttention[];
  retainProjectAttention(roots: readonly Readonly<{ projectId: string; rootKey: string }>[]): void;
}>;

export function logicalSkillNodeId(skillId: string): string {
  return `logical-skill:${skillId}`;
}

export function resourceNodeId(ref: ResourceRef, relativePath?: string): string {
  return JSON.stringify([ref, relativePath ?? null]);
}
