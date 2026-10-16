import type { Binding } from "../assignment-plan";
import { resolveTarget } from "../harness-targets";
import type { ObservedArtifact, ObservedPackage, ObservedPackageFormat } from "../inventory";
import { artifactName } from "../identity-findings-utils";
import type { EntryRef, Observation } from "../project-source-registry";
import type { SkillOriginEvidence } from "../skill-origins/types";
import type { BindingSnapshot, ResourceRef } from "./types";

type ProjectArtifactRef = Extract<ResourceRef, { kind: "artifact" }>;
type ProjectPackageRef = Extract<ResourceRef, { kind: "package" }>;
export type ProjectSkillLocation = Readonly<{
  ref: ProjectArtifactRef;
  relativePath: string;
  origin?: SkillOriginEvidence;
  membershipIssue?: "ambiguous-assignment" | "assignment-origin-disagreement" | "source-unavailable";
}>;
export type ProjectSkillGroup = Readonly<{
  id: string;
  category: "managed-plugin" | "origin" | "individual";
  label: string;
  sourcePackage?: ProjectPackageRef;
  source?: Readonly<{ kind: "github"; locator: string }>;
  locations: readonly ProjectSkillLocation[];
}>;
export type ProjectSkillGroupPackage = Readonly<{
  ref: ProjectPackageRef;
  label: string;
  relativeRoot: string;
  format: ObservedPackageFormat;
  skillPaths: readonly string[];
}>;
export type SourceSkillPackageObservation = Readonly<{
  ref: ProjectPackageRef;
  label: string;
  pkg: ObservedPackage;
  artifacts: readonly ObservedArtifact[];
}>;

type Input = Readonly<{
  projectId: string;
  locations: readonly ProjectSkillLocation[];
  bindings: BindingSnapshot;
  packages: readonly ProjectSkillGroupPackage[];
}>;
type Candidate = Readonly<{ key: string; pkg?: ProjectSkillGroupPackage; available: boolean }>;
type GroupAccumulator = {
  managed: Map<string, { pkg: ProjectSkillGroupPackage; locations: ProjectSkillLocation[] }>;
  origins: Map<string, { locator: string; locations: ProjectSkillLocation[] }>;
  individual: ProjectSkillLocation[];
};

function entryKey(entry: EntryRef): string {
  return JSON.stringify([entry.kind, entry.id]);
}

function artifactRefKey(ref: ProjectArtifactRef): string {
  return JSON.stringify([entryKey(ref.entry), ref.artifactId]);
}

function locationKey(ref: ProjectArtifactRef, relativePath: string): string {
  return JSON.stringify([artifactRefKey(ref), relativePath]);
}

function packageKey(ref: ProjectPackageRef): string {
  return JSON.stringify([entryKey(ref.entry), ref.packageId]);
}

function normalizedRelativePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function bindingLocation(binding: Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  try {
    const artifactPath = normalizedRelativePath(binding.artifactPath);
    if (!artifactPath) return undefined;
    const id = artifactName({ kind: "skill", provenance: { relativePath: artifactPath } });
    const target = resolveTarget({ kind: "skill", id, harnessId: binding.harnessId });
    return target.status === "target" && target.unit === "folder" ? `${target.relativePath}/SKILL.md` : undefined;
  } catch {
    return undefined;
  }
}

function sourceChildExists(pkg: ProjectSkillGroupPackage, artifactPath: string): boolean {
  const wanted = normalizedRelativePath(artifactPath);
  if (!wanted) return false;
  return pkg.skillPaths.some((path) => {
    const child = normalizedRelativePath(path);
    if (!child || !child.endsWith("/SKILL.md")) return false;
    return wanted === child || wanted === child.slice(0, -"/SKILL.md".length);
  });
}

function deduplicateLocations(locations: readonly ProjectSkillLocation[], projectId: string): ProjectSkillLocation[] {
  const unique = new Map<string, ProjectSkillLocation>();
  for (const location of locations) {
    if (location.ref.entry.kind !== "project" || location.ref.entry.id !== projectId) continue;
    const key = locationKey(location.ref, location.relativePath);
    if (!unique.has(key)) unique.set(key, location);
  }
  return [...unique.values()];
}

function locationName(location: ProjectSkillLocation): string {
  const withoutFile = location.relativePath.replace(/\/SKILL\.md$/i, "");
  return withoutFile.split("/").at(-1) ?? withoutFile;
}

function sortLocations(locations: readonly ProjectSkillLocation[]): ProjectSkillLocation[] {
  return [...locations].sort(
    (left, right) =>
      locationName(left).localeCompare(locationName(right), undefined, { sensitivity: "base" }) ||
      left.relativePath.localeCompare(right.relativePath) ||
      artifactRefKey(left.ref).localeCompare(artifactRefKey(right.ref)),
  );
}

function groupSortKey(group: ProjectSkillGroup): number {
  return group.category === "managed-plugin" ? 0 : group.category === "origin" ? 1 : 2;
}

function sortGroups(groups: readonly ProjectSkillGroup[]): ProjectSkillGroup[] {
  return [...groups].sort(
    (left, right) =>
      groupSortKey(left) - groupSortKey(right) ||
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }) ||
      left.id.localeCompare(right.id),
  );
}

function githubKey(locator: string): string {
  return locator.toLocaleLowerCase("en-US");
}

function indexLocationsByPath(locations: readonly ProjectSkillLocation[]): Map<string, ProjectSkillLocation[]> {
  const locationByPath = new Map<string, ProjectSkillLocation[]>();
  for (const location of locations) {
    locationByPath.set(location.relativePath, [...(locationByPath.get(location.relativePath) ?? []), location]);
  }
  return locationByPath;
}

function indexPackages(packages: readonly ProjectSkillGroupPackage[]): Map<string, ProjectSkillGroupPackage> {
  return new Map(
    packages.filter((pkg) => pkg.ref.entry.kind === "source").map((pkg) => [packageKey(pkg.ref), pkg] as const),
  );
}

function addClaim(
  claims: Map<string, Map<string, Candidate>>,
  location: ProjectSkillLocation,
  binding: Binding,
  packageByKey: ReadonlyMap<string, ProjectSkillGroupPackage>,
): void {
  const ref: ProjectPackageRef = {
    kind: "package",
    entry: { kind: "source", id: binding.sourceId },
    packageId: binding.packageId,
  };
  const key = packageKey(ref);
  const pkg = packageByKey.get(key);
  const candidate: Candidate = {
    key,
    ...(pkg ? { pkg } : {}),
    available: Boolean(pkg && sourceChildExists(pkg, binding.artifactPath)),
  };
  const keyForLocation = locationKey(location.ref, location.relativePath);
  const candidates = claims.get(keyForLocation) ?? new Map<string, Candidate>();
  const previous = candidates.get(key);
  candidates.set(key, { ...candidate, available: candidate.available && (previous?.available ?? true) });
  claims.set(keyForLocation, candidates);
}

function collectClaims(
  bindings: BindingSnapshot,
  projectId: string,
  locations: readonly ProjectSkillLocation[],
  packageByKey: ReadonlyMap<string, ProjectSkillGroupPackage>,
): Map<string, Map<string, Candidate>> {
  const claims = new Map<string, Map<string, Candidate>>();
  if (bindings.status !== "ready") return claims;
  const locationByPath = indexLocationsByPath(locations);
  for (const binding of bindings.bindings) {
    if (binding.projectId !== projectId || binding.kind !== "skill") continue;
    const targetPath = bindingLocation(binding);
    if (!targetPath) continue;
    for (const location of locationByPath.get(targetPath) ?? []) addClaim(claims, location, binding, packageByKey);
  }
  return claims;
}

function createAccumulator(): GroupAccumulator {
  return { managed: new Map(), origins: new Map(), individual: [] };
}

function addLocationToGroups(
  location: ProjectSkillLocation,
  claims: ReadonlyMap<string, Map<string, Candidate>>,
  groups: GroupAccumulator,
): void {
  const candidates = [...(claims.get(locationKey(location.ref, location.relativePath))?.values() ?? [])];
  const available = candidates.filter((candidate) => candidate.available && candidate.pkg);
  if (available.length > 1) {
    groups.individual.push({ ...location, membershipIssue: "ambiguous-assignment" });
    return;
  }
  if (candidates.some((candidate) => !candidate.available)) {
    groups.individual.push({ ...location, membershipIssue: "source-unavailable" });
    return;
  }
  const selected = available[0];
  if (selected?.pkg) {
    const managed = groups.managed.get(selected.key) ?? { pkg: selected.pkg, locations: [] };
    managed.locations.push({
      ...location,
      ...(location.origin ? { membershipIssue: "assignment-origin-disagreement" as const } : {}),
    });
    groups.managed.set(selected.key, managed);
    return;
  }
  if (!location.origin) {
    groups.individual.push(location);
    return;
  }
  const key = githubKey(location.origin.source.locator);
  const origin = groups.origins.get(key) ?? { locator: location.origin.source.locator, locations: [] };
  origin.locations.push(location);
  groups.origins.set(key, origin);
}

function buildGroups(groups: GroupAccumulator): ProjectSkillGroup[] {
  return sortGroups([
    ...[...groups.managed.entries()].map(([, group]) => ({
      id: JSON.stringify(["managed", group.pkg.ref.entry.id, group.pkg.ref.packageId]),
      category: "managed-plugin" as const,
      label: group.pkg.label,
      sourcePackage: group.pkg.ref,
      locations: sortLocations(group.locations),
    })),
    ...[...groups.origins.entries()].map(([key, group]) => ({
      id: JSON.stringify(["origin", "github", key]),
      category: "origin" as const,
      label: group.locator,
      source: { kind: "github" as const, locator: group.locator },
      locations: sortLocations(group.locations),
    })),
    ...(groups.individual.length > 0
      ? [
          {
            id: "individual-skills",
            category: "individual" as const,
            label: "Individual skills",
            locations: sortLocations(groups.individual),
          },
        ]
      : []),
  ]);
}

export function createProjectSkillGroups(input: Input): readonly ProjectSkillGroup[] {
  const locations = deduplicateLocations(input.locations, input.projectId);
  if (locations.length === 0) return [];
  const claims = collectClaims(input.bindings, input.projectId, locations, indexPackages(input.packages));
  const groups = createAccumulator();
  for (const location of locations) addLocationToGroups(location, claims, groups);
  return buildGroups(groups);
}

export function createProjectSkillGroupsFromObservations(
  input: Readonly<{
    projectId: string;
    observation: Observation;
    bindings: BindingSnapshot;
    sourcePackages: readonly SourceSkillPackageObservation[];
  }>,
): readonly ProjectSkillGroup[] {
  const packageOwnedIds = new Set((input.observation.inventory.packages ?? []).flatMap((pkg) => pkg.artifactIds));
  const originByLocation = new Map(
    (input.observation.inventory.skillOrigins ?? []).map((origin) => [
      locationKey(
        { kind: "artifact", entry: input.observation.subject, artifactId: origin.artifactId },
        origin.relativePath,
      ),
      origin,
    ]),
  );
  const locations = input.observation.inventory.artifacts
    .filter((artifact) => artifact.kind === "skill" && !artifact.packageId && !packageOwnedIds.has(artifact.id))
    .flatMap((artifact) =>
      [...new Set(artifact.projectionPaths)]
        .filter((relativePath) => relativePath.endsWith("/SKILL.md"))
        .map((relativePath): ProjectSkillLocation => {
          const ref: ProjectArtifactRef = {
            kind: "artifact",
            entry: input.observation.subject,
            artifactId: artifact.id,
          };
          const origin = originByLocation.get(locationKey(ref, relativePath));
          return { ref, relativePath, ...(origin ? { origin } : {}) };
        }),
    );
  const packages = input.sourcePackages.map(({ ref, label, pkg, artifacts }): ProjectSkillGroupPackage => {
    const root = `${pkg.relativeRoot.replace(/\/$/, "")}/`;
    const skillPaths = artifacts
      .filter(
        (artifact) =>
          artifact.kind === "skill" && artifact.packageId === pkg.id && pkg.artifactIds.includes(artifact.id),
      )
      .flatMap((artifact) => artifact.projectionPaths)
      .filter((path) => path.startsWith(root) && path.endsWith("/SKILL.md"))
      .map((path) => path.slice(root.length));
    return { ref, label, relativeRoot: pkg.relativeRoot, format: pkg.format, skillPaths: [...new Set(skillPaths)] };
  });
  return createProjectSkillGroups({ projectId: input.projectId, locations, bindings: input.bindings, packages });
}

export function projectSkillOriginsForArtifact(
  observation: Observation,
  artifact: ObservedArtifact,
): readonly SkillOriginEvidence[] {
  const paths = new Set([artifact.relativePath, ...artifact.projectionPaths]);
  return (observation.inventory.skillOrigins ?? []).filter(
    (origin) => origin.artifactId === artifact.id && paths.has(origin.relativePath),
  );
}

export function projectSkillMembershipIssuesForArtifact(
  groups: readonly ProjectSkillGroup[],
  ref: ResourceRef,
): readonly Readonly<{
  relativePath: string;
  reason: NonNullable<ProjectSkillGroup["locations"][number]["membershipIssue"]>;
}>[] {
  if (ref.kind !== "artifact") return [];
  type Issue = {
    relativePath: string;
    reason: NonNullable<ProjectSkillGroup["locations"][number]["membershipIssue"]>;
  };
  const issues = new Map<string, Issue>();
  for (const group of groups) {
    for (const location of group.locations) {
      if (!location.membershipIssue || artifactRefKey(location.ref) !== artifactRefKey(ref)) continue;
      const key = JSON.stringify([location.relativePath, location.membershipIssue]);
      issues.set(key, { relativePath: location.relativePath, reason: location.membershipIssue });
    }
  }
  return [...issues.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
