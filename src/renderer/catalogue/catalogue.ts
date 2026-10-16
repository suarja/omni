import { activeWorkshop } from "../../domain/source-roles";
import type { InventoryArtifactKind } from "../../domain/inventory";
import { artifactName, collapsePhysicalProjections, type ArtifactIdentity } from "../../domain/identity";
import type { EntryRef, RegistryView } from "../../domain/project-source-registry";
import type { AuditObservation, AuditReport } from "../audit/audit-report";

export type CatalogueOccurrence = Readonly<{
  root: EntryRef;
  relativePath: string;
  contentHash: string;
  packageId?: string;
  physicalIdentity: string;
}>;

export type CatalogueUnit = Readonly<{
  unitId: string;
  name: string;
  kind: InventoryArtifactKind;
  unit: "skill-folder" | "file";
  occurrences: readonly CatalogueOccurrence[];
  inPersonalSource: boolean;
  personalHash?: string;
}>;

export type ProjectContextState = "current" | "modified" | "unmanaged" | "available";
export type ProjectContextItem = Readonly<{ unit: CatalogueUnit; state: ProjectContextState }>;
export type ProjectContext = Readonly<{
  managed: readonly ProjectContextItem[];
  unmanaged: readonly ProjectContextItem[];
  available: readonly ProjectContextItem[];
}>;

export type CatalogueInput = Readonly<{
  registry: RegistryView;
  report: AuditReport;
  entryIdentities: Readonly<Record<string, AuditObservation>>;
}>;

function entryKey(entry: EntryRef): string {
  return `${entry.kind}:${entry.id}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSameEntry(left: EntryRef, right: EntryRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function skillName(identity: ArtifactIdentity): string | undefined {
  const path = identity.logicalId
    .replace(/^loose:/, "")
    .replaceAll("\\", "/")
    .split("/");
  const skillsIndex = path.indexOf("skills");
  return skillsIndex >= 0 && path[skillsIndex + 1] ? path[skillsIndex + 1] : undefined;
}

function isSkillFolder(identity: ArtifactIdentity): boolean {
  return skillName(identity) !== undefined;
}

function unitKey(identity: ArtifactIdentity): string {
  const name = artifactName(identity);
  return isSkillFolder(identity) ? `skill:${skillName(identity)}` : `file:${identity.kind}:${identity.logicalId}`;
}

function rootIdentities(input: CatalogueInput, ref: EntryRef): readonly ArtifactIdentity[] {
  const reportObservation = input.report.observations.find((observation) => isSameEntry(observation.subject, ref));
  const cachedObservation = input.entryIdentities[entryKey(ref)];
  return reportObservation?.identities ?? cachedObservation?.identities ?? [];
}

function physicalLookup(input: CatalogueInput, ref: EntryRef): ReadonlyMap<string, string> {
  const observation =
    input.report.observations.find((candidate) => isSameEntry(candidate.subject, ref)) ??
    input.entryIdentities[entryKey(ref)];
  return new Map((observation?.inventory.artifacts ?? []).map((artifact) => [artifact.id, artifact.physicalIdentity]));
}

function representative(members: readonly ArtifactIdentity[]): ArtifactIdentity {
  return [...members].sort(
    (left, right) =>
      Number(!left.provenance.relativePath.endsWith("/SKILL.md")) -
        Number(!right.provenance.relativePath.endsWith("/SKILL.md")) ||
      compare(left.provenance.relativePath, right.provenance.relativePath),
  )[0]!;
}

function sourceRefs(registry: RegistryView): readonly EntryRef[] {
  return registry.sources.filter((source) => source.archivedAt === undefined).map((source) => source.ref);
}

function projectRefs(registry: RegistryView): readonly EntryRef[] {
  return registry.projects.filter((project) => project.archivedAt === undefined).map((project) => project.ref);
}

function buildOccurrenceGroups(
  input: CatalogueInput,
): Map<string, { identities: ArtifactIdentity[]; physical: ReadonlyMap<string, string> }> {
  const groups = new Map<string, { identities: ArtifactIdentity[]; physical: ReadonlyMap<string, string> }>();
  for (const ref of [...sourceRefs(input.registry), ...projectRefs(input.registry)]) {
    const physical = physicalLookup(input, ref);
    for (const identity of collapsePhysicalProjections(rootIdentities(input, ref), physical)) {
      const key = `${entryKey(ref)}:${unitKey(identity)}`;
      const group = groups.get(key) ?? { identities: [], physical };
      group.identities.push(identity);
      groups.set(key, group);
    }
  }
  return groups;
}

function createUnit(
  key: string,
  group: { identities: readonly ArtifactIdentity[]; physical: ReadonlyMap<string, string> },
  registry: RegistryView,
): CatalogueUnit {
  const members = [...group.identities].sort((left, right) =>
    compare(left.provenance.relativePath, right.provenance.relativePath),
  );
  const first = representative(members);
  const name = artifactName(first);
  const workshop = activeWorkshop(registry);
  const personalMembers = members.filter((identity) => workshop && isSameEntry(workshop.ref, identity.provenance.root));
  return {
    unitId: key.split(":").slice(2).join(":"),
    name,
    kind: members.some((identity) => identity.kind === "skill") ? "skill" : first.kind,
    unit: isSkillFolder(first) ? "skill-folder" : "file",
    occurrences: [
      {
        root: first.provenance.root,
        relativePath: first.provenance.relativePath,
        contentHash: first.contentHash,
        ...(first.provenance.packageId ? { packageId: first.provenance.packageId } : {}),
        physicalIdentity: group.physical.get(first.artifactId) ?? first.provenance.relativePath,
      },
    ],
    inPersonalSource: personalMembers.length > 0,
    ...(personalMembers[0] ? { personalHash: personalMembers[0].contentHash } : {}),
  };
}

function mergeUnits(units: readonly CatalogueUnit[]): CatalogueUnit[] {
  const byKey = new Map<string, CatalogueUnit>();
  for (const unit of units) {
    const existing = byKey.get(unit.unitId);
    if (!existing) {
      byKey.set(unit.unitId, unit);
      continue;
    }
    const occurrences = [...existing.occurrences, ...unit.occurrences].sort((left, right) =>
      compare(entryKey(left.root), entryKey(right.root)),
    );
    const personal = occurrences.find((occurrence) => occurrence.root.kind === "source");
    byKey.set(unit.unitId, {
      ...existing,
      occurrences,
      inPersonalSource: existing.inPersonalSource || unit.inPersonalSource,
      ...(personal ? { personalHash: personal.contentHash } : {}),
    });
  }
  return [...byKey.values()];
}

function sameNameAndKind(left: CatalogueUnit, right: CatalogueUnit): boolean {
  return left.name === right.name && left.kind === right.kind;
}

function projectOccurrence(
  unit: CatalogueUnit,
  projectRef: EntryRef,
  personalUnits: readonly CatalogueUnit[],
): CatalogueOccurrence | undefined {
  const direct = unit.occurrences.find((occurrence) => isSameEntry(occurrence.root, projectRef));
  if (direct) return direct;
  return personalUnits
    .filter((candidate) => candidate !== unit && sameNameAndKind(candidate, unit))
    .flatMap((candidate) => candidate.occurrences)
    .find((occurrence) => isSameEntry(occurrence.root, projectRef));
}

export function buildCatalogue(input: CatalogueInput): readonly CatalogueUnit[] {
  const units = [...buildOccurrenceGroups(input)].map(([key, group]) => createUnit(key, group, input.registry));
  const merged = mergeUnits(units);
  const personalUnits = merged.filter((unit) => unit.inPersonalSource);
  return merged
    .map((unit) => {
      const personal = personalUnits.find(
        (candidate) =>
          candidate === unit ||
          sameNameAndKind(candidate, unit) ||
          candidate.occurrences.some((left) =>
            unit.occurrences.some((right) => left.contentHash === right.contentHash),
          ),
      );
      return personal && !unit.inPersonalSource
        ? { ...unit, inPersonalSource: true, personalHash: personal.personalHash }
        : unit;
    })
    .sort((left, right) => compare(left.name, right.name) || compare(left.unitId, right.unitId));
}

export function projectContext(catalogue: readonly CatalogueUnit[], projectRef: EntryRef): ProjectContext {
  const personalUnits = catalogue.filter(
    (unit) => unit.inPersonalSource && unit.occurrences.some((occurrence) => occurrence.root.kind === "source"),
  );
  const projectUnits = catalogue.filter((unit) =>
    unit.occurrences.some((occurrence) => isSameEntry(occurrence.root, projectRef)),
  );
  const managed: ProjectContextItem[] = [];
  const available: ProjectContextItem[] = [];
  const matched = new Set<CatalogueUnit>();
  for (const unit of personalUnits) {
    const occurrence = projectOccurrence(unit, projectRef, personalUnits);
    if (!occurrence) {
      available.push({ unit, state: "available" });
      continue;
    }
    managed.push({ unit, state: occurrence.contentHash === unit.personalHash ? "current" : "modified" });
    matched.add(unit);
  }
  const unmanaged = projectUnits
    .filter(
      (unit) =>
        !matched.has(unit) &&
        !personalUnits.some(
          (candidate) =>
            sameNameAndKind(candidate, unit) ||
            candidate.occurrences.some((occurrence) =>
              unit.occurrences.some(
                (candidateOccurrence) => candidateOccurrence.contentHash === occurrence.contentHash,
              ),
            ),
        ),
    )
    .map((unit) => ({ unit, state: "unmanaged" as const }));
  const sortItems = (items: readonly ProjectContextItem[]): ProjectContextItem[] =>
    [...items].sort(
      (left, right) => compare(left.unit.name, right.unit.name) || compare(left.unit.unitId, right.unit.unitId),
    );
  return { managed: sortItems(managed), unmanaged: sortItems(unmanaged), available: sortItems(available) };
}
