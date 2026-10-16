import type {
  ResourceCatalogue,
  ResourceContext,
  ResourceListing,
  ResourceRecord,
  ResourceRef,
  ProjectSkillGroup,
} from "../../../domain/resource-catalogue";
import type { EntryRef } from "../../../domain/project-source-registry";
import {
  aggregateSkillAttention,
  deriveManagedSkillAttention,
  deriveSkillAttention,
} from "../../../domain/skill-reconciliation/attention";
import type { SkillAttentionSummary } from "../../../domain/skill-reconciliation/attention";
import type {
  LogicalSkillRecord,
  SkillCopyLocationRead,
  SkillCorrelation,
  SkillLocationKey,
  SkillMember,
  SkillManagedAttention,
} from "../../../domain/skill-reconciliation/types";
import type { RetainedSkillCopies } from "../../../shared/skill-reconciliation-ipc";
import type { CanvasGroup, CanvasNode, CanvasProjection } from "./spatial-types";
import { logicalSkillNodeId, resourceNodeId } from "./spatial-types";

const groupDefinitions = [
  { id: "project-instructions", label: "canvas.groupProjectInstructions" },
  { id: "other", label: "canvas.groupOtherResources" },
] as const;

function entryKey(ref: ResourceRef): string {
  return `${ref.entry.kind}:${ref.entry.id}`;
}

export function canvasContextKey(context: ResourceContext): string {
  if (context.kind === "workspace") return "workspace";
  const resolved = context.kind === "artifact" ? { kind: "entry" as const, entry: context.entry } : context;
  const root = `entry:${entryKey(resolved)}`;
  return resolved.kind === "package" ? `${root}:package:${resolved.packageId}` : root;
}

function contextKey(listing: ResourceListing): string {
  return canvasContextKey(listing.context);
}

function groupForPath(path: string): (typeof groupDefinitions)[number]["id"] {
  if (/^(AGENTS|CLAUDE)\.md$/i.test(path)) return "project-instructions";
  return "other";
}

function resourceNode(resource: ResourceRecord, relativePath?: string, attention?: SkillAttentionSummary): CanvasNode {
  return {
    kind: "resource",
    id: resourceNodeId(resource.ref, relativePath),
    resource,
    ...(relativePath ? { relativePath } : {}),
    ...(attention && attention.state !== "quiet" ? { attention } : {}),
  };
}

function groupNode(group: CanvasGroup): CanvasNode {
  return {
    kind: "group",
    id: `group:${group.id}`,
    groupId: group.id,
    label: group.label,
    ...(group.labelKind ? { labelKind: group.labelKind } : {}),
    ...(group.category ? { category: group.category } : {}),
    ...(group.projectSkillGroup ? { projectSkillGroup: group.projectSkillGroup } : {}),
    ...(group.attention ? { attention: group.attention } : {}),
  };
}

function compareNodes(left: CanvasNode, right: CanvasNode): number {
  const leftLabel = left.kind === "resource" ? left.resource.label : left.label;
  const rightLabel = right.kind === "resource" ? right.resource.label : right.label;
  const leftPath =
    left.kind === "resource"
      ? (left.relativePath ?? left.resource.relativePath ?? "")
      : left.kind === "logical-skill"
        ? (left.members[0]?.location.folderPath ?? left.locations[0]?.location.folderPath ?? "")
        : "";
  const rightPath =
    right.kind === "resource"
      ? (right.relativePath ?? right.resource.relativePath ?? "")
      : right.kind === "logical-skill"
        ? (right.members[0]?.location.folderPath ?? right.locations[0]?.location.folderPath ?? "")
        : "";
  return (
    leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" }) ||
    leftPath.localeCompare(rightPath) ||
    left.id.localeCompare(right.id)
  );
}

function actualRelations(listing: ResourceListing, nodes: readonly CanvasNode[]): CanvasProjection["relations"] {
  const resourceIds = new Set(
    nodes.filter((node) => node.kind === "resource").map((node) => resourceNodeId(node.resource.ref)),
  );
  return listing.relations.flatMap((relation) => {
    const from = resourceNodeId(relation.from);
    const to = resourceNodeId(relation.to);
    return resourceIds.has(from) && resourceIds.has(to) ? [{ from, to, kind: relation.kind }] : [];
  });
}

function matchesLocation(location: SkillLocationKey, relativePath: string): boolean {
  const harnessId = relativePath.startsWith(".agents/")
    ? "codex"
    : relativePath.startsWith(".claude/")
      ? "claude-code"
      : relativePath.startsWith(".cursor/")
        ? "cursor"
        : undefined;
  return harnessId === location.harnessId && relativePath.replace(/\/SKILL\.md$/u, "") === location.folderPath;
}

function skillLocationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function managedAttentionKey(skillId: string, location: SkillLocationKey): string {
  return `${skillId}\n${skillLocationKey(location)}`;
}

function logicalSkillAttention(
  skillId: string,
  locations: readonly SkillCopyLocationRead[],
  managed: ReadonlyMap<string, SkillManagedAttention["state"]>,
) {
  return aggregateSkillAttention([
    deriveSkillAttention(locations),
    ...locations.flatMap(({ location }) => {
      const summary = deriveManagedSkillAttention(managed.get(managedAttentionKey(skillId, location)));
      return summary.state === "quiet" ? [] : [summary];
    }),
  ]);
}

function retainedGroupId(retained: RetainedSkillCopies, groups: readonly ProjectSkillGroup[]): string {
  for (const location of retained.record.locations) {
    const group = groups.find((candidate) =>
      candidate.locations.some((item) => matchesLocation(location, item.relativePath)),
    );
    if (group) return group.id;
  }
  return "individual-skills";
}

function attentionForChildren(children: readonly CanvasNode[]): ReturnType<typeof aggregateSkillAttention> {
  return aggregateSkillAttention(
    children.flatMap((child) =>
      child.kind === "logical-skill" && child.attention.state !== "quiet" ? [child.attention] : [],
    ),
  );
}

type MergedSkill = {
  record: LogicalSkillRecord;
  groupIds: Set<string>;
  members: Map<string, SkillMember>;
  locations: Map<string, SkillCopyLocationRead>;
  recordLocations: Map<string, SkillLocationKey>;
};

function mergeLocationRead(
  previous: SkillCopyLocationRead | undefined,
  next: SkillCopyLocationRead,
): SkillCopyLocationRead {
  if (!previous) return next;
  if (JSON.stringify(previous.read) === JSON.stringify(next.read)) return previous;
  return { location: previous.location, read: { status: "unavailable", reason: "changed-during-read" } };
}

function collectMergedSkills(logicalCopies: ReadonlyMap<string, SkillCorrelation>): Map<string, MergedSkill> {
  const merged = new Map<string, MergedSkill>();
  const correlations = [...logicalCopies].sort(([left], [right]) => left.localeCompare(right));
  for (const [groupId, correlation] of correlations) {
    for (const logical of correlation.groups) {
      const record = correlation.records.find((candidate) => candidate.skillId === logical.skillId);
      if (!record || logical.members.length === 0) continue;
      const skill = merged.get(logical.skillId) ?? {
        record,
        groupIds: new Set<string>(),
        members: new Map<string, SkillMember>(),
        locations: new Map<string, SkillCopyLocationRead>(),
        recordLocations: new Map<string, SkillLocationKey>(),
      };
      skill.groupIds.add(groupId);
      for (const location of record.locations) skill.recordLocations.set(skillLocationKey(location), location);
      for (const member of logical.members) {
        const key = skillLocationKey(member.location);
        const previous = skill.members.get(key);
        const mergedRead = mergeLocationRead(
          previous ? { location: previous.location, read: previous.read } : undefined,
          {
            location: member.location,
            read: member.read,
          },
        );
        skill.members.set(key, { ...previous, ...member, read: mergedRead.read });
      }
      for (const location of logical.locations) {
        const key = skillLocationKey(location.location);
        skill.locations.set(key, mergeLocationRead(skill.locations.get(key), location));
      }
      merged.set(logical.skillId, skill);
    }
  }
  return merged;
}

function anchorSkillGroup(skill: MergedSkill, groups: readonly ProjectSkillGroup[]): string {
  const represented = groups.filter((group) => skill.groupIds.has(group.id));
  const managed = represented.filter(
    (group) => group.category === "managed-plugin" && group.sourcePackage?.entry.kind === "source",
  );
  if (managed.length === 1) return managed[0]!.id;
  const declaration = skill.record.declaration?.locator.toLocaleLowerCase("en-US");
  const origins = represented.filter(
    (group) => group.category === "origin" && group.source?.locator.toLocaleLowerCase("en-US") === declaration,
  );
  if (origins.length === 1) return origins[0]!.id;
  return "individual-skills";
}

function projectMergedSkills(
  logicalCopies: ReadonlyMap<string, SkillCorrelation>,
  groups: readonly ProjectSkillGroup[],
  managed: ReadonlyMap<string, SkillManagedAttention["state"]>,
): ReadonlyMap<string, readonly CanvasNode[]> {
  const byGroup = new Map<string, CanvasNode[]>();
  for (const [skillId, skill] of collectMergedSkills(logicalCopies)) {
    const anchor = anchorSkillGroup(skill, groups);
    const record = {
      ...skill.record,
      locations: [...skill.recordLocations.values()].sort((left, right) =>
        skillLocationKey(left).localeCompare(skillLocationKey(right)),
      ),
    };
    const node: CanvasNode = {
      kind: "logical-skill",
      id: logicalSkillNodeId(skillId),
      skillId,
      label: record.label,
      groupId: anchor,
      record,
      members: [...skill.members.values()].sort((left, right) =>
        skillLocationKey(left.location).localeCompare(skillLocationKey(right.location)),
      ),
      locations: [...skill.locations.values()].sort((left, right) =>
        skillLocationKey(left.location).localeCompare(skillLocationKey(right.location)),
      ),
      attention: logicalSkillAttention(skillId, [...skill.locations.values()], managed),
    };
    byGroup.set(anchor, [...(byGroup.get(anchor) ?? []), node]);
  }
  return new Map([...byGroup].map(([groupId, nodes]) => [groupId, nodes.sort(compareNodes)]));
}

function projectInventorySkills(group: ProjectSkillGroup, catalogue: ResourceCatalogue): CanvasNode[] {
  return group.locations
    .flatMap((location) => {
      const resource = catalogue.inspect(location.ref)?.resource;
      return resource ? [resourceNode(resource, location.relativePath)] : [];
    })
    .sort(compareNodes);
}

function projectRetainedSkills(
  groupId: string,
  retained: readonly RetainedSkillCopies[],
  managed: ReadonlyMap<string, SkillManagedAttention["state"]>,
): CanvasNode[] {
  return retained.map((item): CanvasNode => ({
    kind: "logical-skill",
    id: logicalSkillNodeId(item.record.skillId),
    skillId: item.record.skillId,
    label: item.record.label,
    groupId,
    record: item.record,
    members: [],
    locations: item.locations,
    attention: logicalSkillAttention(item.record.skillId, item.locations, managed),
  }));
}

function projectSemanticGroup(
  group: ProjectSkillGroup,
  catalogue: ResourceCatalogue,
  correlation: SkillCorrelation | undefined,
  logicalSkills: ReadonlyMap<string, readonly CanvasNode[]>,
  retained: readonly RetainedSkillCopies[],
  managed: ReadonlyMap<string, SkillManagedAttention["state"]>,
): CanvasGroup | undefined {
  const inventoryChildren = correlation
    ? [...(logicalSkills.get(group.id) ?? [])]
    : projectInventorySkills(group, catalogue);
  const children = [...inventoryChildren, ...projectRetainedSkills(group.id, retained, managed)].sort(compareNodes);
  if (!children.length) return undefined;
  const attention = attentionForChildren(children);
  return {
    id: group.id,
    label: group.category === "individual" ? "canvas.groupIndividualSkills" : group.label,
    ...(group.category === "individual" ? {} : { labelKind: "literal" as const }),
    category: group.category,
    projectSkillGroup: group,
    children,
    ...(attention.state !== "quiet" ? { attention } : {}),
  };
}

function projectLocationGroups(
  listing: ResourceListing,
  catalogue: ResourceCatalogue,
  projectEntry: EntryRef,
  logicalCopies: ReadonlyMap<string, SkillCorrelation>,
  retainedSkills: readonly RetainedSkillCopies[],
  managed: ReadonlyMap<string, SkillManagedAttention["state"]>,
): readonly CanvasGroup[] {
  const loose = listing.children.filter((resource) => {
    if (resource.kind === "plugin") return false;
    return catalogue.inspect(resource.ref)?.parent?.kind !== "package";
  });
  const supportPaths = new Set<string>();
  for (const resource of loose) {
    if (resource.artifactKind !== "skill") continue;
    for (const file of catalogue.inspect(resource.ref)?.files ?? []) {
      if (file.role === "support") supportPaths.add(file.relativePath);
    }
  }

  const projectSkillGroups = catalogue.projectSkillGroups(projectEntry);
  const logicalSkills = projectMergedSkills(logicalCopies, projectSkillGroups, managed);
  const logicalSkillIds = new Set(collectMergedSkills(logicalCopies).keys());
  const retainedByGroup = new Map<string, RetainedSkillCopies[]>();
  for (const retained of retainedSkills) {
    if (logicalSkillIds.has(retained.record.skillId)) continue;
    const groupId = retainedGroupId(retained, projectSkillGroups);
    retainedByGroup.set(groupId, [...(retainedByGroup.get(groupId) ?? []), retained]);
  }
  const groupMap = new Map(projectSkillGroups.map((group) => [group.id, group]));
  if (
    (retainedByGroup.has("individual-skills") || logicalSkills.has("individual-skills")) &&
    !groupMap.has("individual-skills")
  ) {
    groupMap.set("individual-skills", {
      id: "individual-skills",
      category: "individual",
      label: "Individual skills",
      locations: [],
    });
  }
  const semanticGroups = [...groupMap.values()].flatMap((group) => {
    const projected = projectSemanticGroup(
      group,
      catalogue,
      logicalCopies.get(group.id),
      logicalSkills,
      retainedByGroup.get(group.id) ?? [],
      managed,
    );
    return projected ? [projected] : [];
  });

  const childrenByGroup = new Map<string, CanvasNode[]>();
  for (const resource of loose) {
    if (resource.artifactKind === "skill") continue;
    const details = catalogue.inspect(resource.ref);
    if (resource.relativePath && supportPaths.has(resource.relativePath)) continue;
    const paths = resource.relativePath ? [resource.relativePath] : [];
    for (const path of paths.length ? paths : [""]) {
      const groupId = path ? groupForPath(path) : "other";
      const groupChildren = childrenByGroup.get(groupId) ?? [];
      groupChildren.push(resourceNode(resource, path || undefined));
      childrenByGroup.set(groupId, groupChildren);
    }
  }

  const fallbackGroups = groupDefinitions.flatMap(({ id, label }) => {
    const children = childrenByGroup.get(id)?.sort(compareNodes) ?? [];
    return children.length ? [{ id, label, children }] : [];
  });
  return [...semanticGroups, ...fallbackGroups];
}

function projectProjectOverview(
  listing: ResourceListing,
  catalogue: ResourceCatalogue,
  projectEntry: EntryRef,
  logicalCopies: ReadonlyMap<string, SkillCorrelation>,
  retainedSkills: readonly RetainedSkillCopies[],
  projectAttention: ReadonlyMap<string, SkillAttentionSummary>,
  managed: ReadonlyMap<string, SkillManagedAttention["state"]>,
): CanvasProjection {
  const packages = listing.children
    .filter((resource) => resource.kind === "plugin")
    .map((resource) => resourceNode(resource));
  const groups = projectLocationGroups(listing, catalogue, projectEntry, logicalCopies, retainedSkills, managed);
  const grouped = groups.map(groupNode);
  const children = [...packages, ...grouped];
  const center = listing.center
    ? resourceNode(listing.center, undefined, projectAttention.get(projectEntry.id))
    : undefined;
  const relations = [...actualRelations(listing, [...packages, ...(center ? [center] : [])])];
  if (center) {
    for (const child of grouped)
      relations.push({
        from: center.id,
        to: child.id,
        kind: "contains",
        ...(child.attention ? { attention: child.attention } : {}),
      });
  }
  return { key: contextKey(listing), ...(center ? { center } : {}), children, groups, relations };
}

function projectOrdinaryListing(
  listing: ResourceListing,
  projectAttention: ReadonlyMap<string, SkillAttentionSummary>,
): CanvasProjection {
  const missing =
    listing.context.kind === "workspace"
      ? listing.children.filter(
          (resource) =>
            resource.kind === "project" &&
            (resource.availability === "missing" || resource.unavailableReason === "missing"),
        )
      : [];
  const missingIds = new Set(missing.map((resource) => resourceNodeId(resource.ref)));
  const children = listing.children
    .filter((resource) => !missingIds.has(resourceNodeId(resource.ref)))
    .map((resource) =>
      resourceNode(
        resource,
        undefined,
        resource.kind === "project" ? projectAttention.get(resource.ref.entry.id) : undefined,
      ),
    );
  if (missing.length)
    children.push({
      kind: "group",
      id: "missing-projects",
      groupId: "missing-projects",
      label: "Missing projects",
      labelKind: "literal",
      missingProjects: missing,
    });
  const center = listing.center ? resourceNode(listing.center) : undefined;
  const relations = actualRelations(listing, [...children, ...(center ? [center] : [])]).filter((relation) => {
    const source = children.find((node) => node.id === relation.from);
    return source?.kind !== "resource" || source.resource.kind !== "storefront";
  });
  if (listing.context.kind === "workspace") {
    const workshop = children.find((node) => node.kind === "resource" && node.resource.kind === "marketplace");
    if (workshop)
      for (const child of children) {
        if (child.kind === "resource" && child.resource.kind === "storefront")
          relations.push({ from: workshop.id, to: child.id, kind: "publication" });
      }
  }
  return { key: contextKey(listing), ...(center ? { center } : {}), children, groups: [], relations };
}

export function projectCanvas(
  listing: ResourceListing,
  catalogue: ResourceCatalogue,
  groupId: string | null,
  logicalCopies: ReadonlyMap<string, SkillCorrelation> = new Map(),
  retainedSkills: readonly RetainedSkillCopies[] = [],
  projectAttention: ReadonlyMap<string, SkillAttentionSummary> = new Map(),
  managedAttention: readonly SkillManagedAttention[] = [],
): CanvasProjection {
  const managed = new Map(
    managedAttention.map((item) => [managedAttentionKey(item.skillId, item.location), item.state]),
  );
  const base =
    listing.context.kind === "entry" && listing.context.entry.kind === "project"
      ? projectProjectOverview(
          listing,
          catalogue,
          listing.context.entry,
          logicalCopies,
          retainedSkills,
          projectAttention,
          managed,
        )
      : projectOrdinaryListing(listing, projectAttention);
  const key = groupId ? `${base.key}:group:${groupId}` : base.key;
  if (!groupId) return { ...base, key };
  const group = base.groups.find((candidate) => candidate.id === groupId);
  if (!group) return base;
  const center = groupNode(group);
  return {
    key,
    center,
    children: group.children,
    groups: base.groups,
    relations: group.children.map((child) => ({
      from: center.id,
      to: child.id,
      kind: "contains",
      ...(child.kind === "logical-skill" && child.attention.state !== "quiet" ? { attention: child.attention } : {}),
    })),
  };
}
