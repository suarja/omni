import type { Binding } from "../assignment-plan";
import type { ObservedArtifact, ObservedPackage } from "../inventory";
import type { Availability, EntryRef, RegistryEntryView } from "../project-source-registry";
import {
  createProjectSkillGroupsFromObservations,
  projectSkillMembershipIssuesForArtifact,
  projectSkillOriginsForArtifact,
  type ProjectSkillGroup,
} from "./project-skill-groups";
import type {
  BindingSnapshot,
  ResourceCatalogue,
  ResourceContext,
  ResourceDetails,
  ResourceListing,
  ResourceRecord,
  ResourceRef,
  ResourceRelation,
  ResourceSnapshot,
  RootEvidence,
} from "./types";

type IndexedEntry = Readonly<{
  view: RegistryEntryView;
  ref: ResourceRef;
  evidence: RootEvidence;
  record: ResourceRecord;
}>;
type IndexedArtifact = Readonly<{
  artifact: ObservedArtifact;
  record: ResourceRecord;
  ref: ResourceRef;
  parent: ResourceRef;
}>;
type IndexedPackage = Readonly<{ pkg: ObservedPackage; record: ResourceRecord; ref: ResourceRef }>;

function entryKey(entry: EntryRef): string {
  return `${entry.kind}:${entry.id}`;
}
function refKey(ref: ResourceRef): string {
  if (ref.kind === "entry") return `entry:${entryKey(ref.entry)}`;
  return `${ref.kind}:${entryKey(ref.entry)}:${ref.kind === "package" ? ref.packageId : ref.artifactId}`;
}
function sameEntry(left: EntryRef, right: EntryRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
function refEqual(left: ResourceRef, right: ResourceRef): boolean {
  return refKey(left) === refKey(right);
}
function containsPath(parent: string, child: string): boolean {
  return child.startsWith(`${parent.replace(/\/$/, "")}/`);
}
function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
function sorted<T extends ResourceRecord>(records: readonly T[]): T[] {
  return [...records].sort(
    (a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || refKey(a.ref).localeCompare(refKey(b.ref)),
  );
}
function statusEvidence(entry: RegistryEntryView, evidence: RootEvidence | undefined): RootEvidence {
  if (entry.availability === "missing") return { status: "unavailable", reason: "missing" };
  if (entry.availability === "inaccessible") return { status: "unavailable", reason: "inaccessible" };
  if (!evidence) return { status: "unobserved" };
  if (evidence.status === "observed" && !sameEntry(evidence.observation.subject, entry.ref))
    return { status: "unavailable", reason: "failed" };
  return evidence;
}
function unavailableReason(evidence: RootEvidence): ResourceRecord["unavailableReason"] {
  return evidence.status === "unavailable" ? evidence.reason : undefined;
}
function recordState(evidence: RootEvidence): ResourceRecord["state"] {
  return evidence.status;
}
function entryRecords(snapshot: ResourceSnapshot): Map<string, IndexedEntry> {
  const evidenceByEntry = new Map(snapshot.roots.map((root) => [entryKey(root.entry), root.evidence]));
  const entries = [...snapshot.registry.sources, ...snapshot.registry.projects]
    .filter((entry) => entry.archivedAt === undefined)
    .map((view): IndexedEntry => {
      const evidence = statusEvidence(view, evidenceByEntry.get(entryKey(view.ref)));
      const ref: ResourceRef = { kind: "entry", entry: view.ref };
      const source =
        view.ref.kind === "source" ? snapshot.registry.sources.find((item) => item.ref.id === view.ref.id) : undefined;
      const record: ResourceRecord = {
        ref,
        label: view.displayName,
        kind:
          view.ref.kind === "project"
            ? "project"
            : source?.role === "storefront"
              ? "storefront"
              : source?.ownership === "external"
                ? "external-source"
                : "marketplace",
        state: recordState(evidence),
        availability: view.availability,
        unavailableReason: unavailableReason(evidence),
      };
      return { view, ref: record.ref, evidence, record };
    });
  const byKey = new Map(entries.map((entry) => [entryKey(entry.view.ref), entry]));
  return new Map(entries.map((entry) => [entryKey(entry.view.ref), entry]));
}
function packageAndArtifactIndexes(entries: Map<string, IndexedEntry>): {
  packages: Map<string, IndexedPackage>;
  artifacts: Map<string, IndexedArtifact>;
} {
  const packages = new Map<string, IndexedPackage>();
  const artifacts = new Map<string, IndexedArtifact>();
  for (const entry of entries.values()) {
    if (entry.evidence.status !== "observed") continue;
    const inventory = entry.evidence.observation.inventory;
    const packageById = new Map((inventory.packages ?? []).map((pkg) => [pkg.id, pkg]));
    for (const pkg of inventory.packages ?? []) {
      const ref: ResourceRef = { kind: "package", entry: entry.view.ref, packageId: pkg.id };
      const item: IndexedPackage = {
        pkg,
        ref,
        record: {
          ref,
          label: pkg.displayName,
          kind: "plugin",
          state: "observed",
          availability: entry.view.availability,
          relativePath: pkg.relativeRoot,
          description: pkg.description,
          version: pkg.version,
          observedAt: entry.evidence.observation.observedAt,
        },
      };
      packages.set(refKey(ref), item);
    }
    const projectionGroups = new Map<string, ObservedArtifact[]>();
    for (const artifact of inventory.artifacts) {
      if (!artifact.packageId || artifact.kind === "plugin-manifest" || artifact.kind === "marketplace-manifest")
        continue;
      const key = `${artifact.packageId}:${artifact.physicalIdentity}`;
      projectionGroups.set(key, [...(projectionGroups.get(key) ?? []), artifact]);
    }
    const canonicalProjection = new Map<string, string>();
    for (const [key, projections] of projectionGroups) {
      const first = [...projections].sort(
        (a, b) => a.relativePath.localeCompare(b.relativePath) || a.id.localeCompare(b.id),
      )[0];
      if (first) canonicalProjection.set(key, first.id);
    }
    for (const artifact of inventory.artifacts) {
      if (artifact.kind === "plugin-manifest" || artifact.kind === "marketplace-manifest") continue;
      const pkg = artifact.packageId ? packageById.get(artifact.packageId) : undefined;
      const parent: ResourceRef = pkg
        ? { kind: "package", entry: entry.view.ref, packageId: pkg.id }
        : { kind: "entry", entry: entry.view.ref };
      let physical = artifact;
      if (artifact.kind !== "skill" && artifact.packageId) {
        const skill = inventory.artifacts.find(
          (candidate) =>
            candidate.kind === "skill" &&
            candidate.packageId === artifact.packageId &&
            (candidate.id === artifact.id ||
              containsPath(candidate.relativePath.replace(/\/SKILL\.md$/i, ""), artifact.relativePath)),
        );
        if (skill && containsPath(skill.relativePath.replace(/\/SKILL\.md$/i, ""), artifact.relativePath)) continue;
      }
      if (artifact.kind === "skill") {
        physical =
          [...inventory.artifacts]
            .filter(
              (candidate) =>
                candidate.kind === "skill" &&
                candidate.packageId === artifact.packageId &&
                candidate.physicalIdentity === artifact.physicalIdentity,
            )
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath))[0] ?? artifact;
        if (physical.id !== artifact.id) continue;
      } else if (
        artifact.packageId &&
        canonicalProjection.get(`${artifact.packageId}:${artifact.physicalIdentity}`) !== artifact.id
      ) {
        continue;
      }
      const ref: ResourceRef = { kind: "artifact", entry: entry.view.ref, artifactId: physical.id };
      const label =
        physical.kind === "skill"
          ? baseName(physical.relativePath.replace(/\/SKILL\.md$/i, ""))
          : baseName(physical.relativePath);
      const record: ResourceRecord = {
        ref,
        label,
        kind: physical.kind === "skill" ? "artifact" : "artifact",
        artifactKind: physical.kind,
        state: "observed",
        availability: entry.view.availability,
        relativePath: physical.relativePath,
        description: physical.summary,
        observedAt: entry.evidence.observation.observedAt,
      };
      artifacts.set(refKey(ref), { artifact: physical, record, ref, parent });
    }
  }
  return { packages, artifacts };
}
function packageSkillFolder(artifact: ObservedArtifact): string {
  return artifact.relativePath.replace(/\/SKILL\.md$/i, "");
}
function observedPaths(artifact: ObservedArtifact): readonly string[] {
  return [...new Set([artifact.relativePath, ...artifact.projectionPaths])];
}
function uniqueFiles(files: ResourceDetails["files"]): ResourceDetails["files"] {
  const byPath = new Map<string, ResourceDetails["files"][number]>();
  for (const file of files) if (!byPath.has(file.relativePath)) byPath.set(file.relativePath, file);
  return [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
function relatedBindings(
  snapshot: ResourceSnapshot,
  resource: ResourceRef,
  artifact?: ObservedArtifact,
  pkg?: ObservedPackage,
): BindingSnapshot {
  if (snapshot.uses.status !== "ready") return snapshot.uses;
  const bindings = snapshot.uses.bindings.filter((binding) => {
    if (resource.kind === "entry")
      return resource.entry.kind === "source"
        ? binding.sourceId === resource.entry.id
        : binding.projectId === resource.entry.id;
    if (resource.kind === "package")
      return binding.sourceId === resource.entry.id && binding.packageId === resource.packageId;
    if (!artifact || resource.entry.kind !== "source") return false;
    const packageInfo = pkg;
    if (
      !packageInfo ||
      artifact.packageId !== packageInfo.id ||
      binding.sourceId !== resource.entry.id ||
      binding.packageId !== packageInfo.id
    )
      return false;
    const root = `${packageInfo.relativeRoot.replace(/\/$/, "")}/`;
    if (!artifact.relativePath.startsWith(root)) return false;
    const relative = artifact.relativePath.slice(root.length);
    const bindingPath =
      artifact.kind === "skill"
        ? packageSkillFolder({ ...artifact, relativePath: relative }).replace(/^\//, "")
        : relative;
    return binding.artifactPath.replaceAll("\\", "/").replace(/^\//, "") === bindingPath;
  });
  return { status: "ready", bindings };
}
function useRelation(bindings: readonly Binding[]): ResourceRelation[] {
  const grouped = new Map<string, { source: ResourceRef; project: ResourceRef; ids: string[] }>();
  for (const binding of bindings) {
    const source: ResourceRef = { kind: "entry", entry: { kind: "source", id: binding.sourceId } };
    const project: ResourceRef = { kind: "entry", entry: { kind: "project", id: binding.projectId } };
    const key = `${refKey(source)}>${refKey(project)}`;
    const current = grouped.get(key) ?? { source, project, ids: [] };
    current.ids.push(binding.bindingId);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((value) => ({
    from: value.source,
    to: value.project,
    kind: "desired-use",
    bindingIds: value.ids.sort(),
  }));
}
function listingStatus(entry: IndexedEntry): ResourceListing["status"] {
  if (entry.evidence.status === "unavailable") return "unavailable";
  if (entry.evidence.status === "loading") return "loading";
  if (entry.evidence.status === "unobserved") return "unobserved";
  return entry.evidence.observation.inventory.diagnostics.some(
    (item) => item.code !== "git-unavailable" && item.severity !== "info",
  )
    ? "partial"
    : "ready";
}
function sortRelations(relations: readonly ResourceRelation[]): ResourceRelation[] {
  return [...relations].sort(
    (a, b) =>
      refKey(a.from).localeCompare(refKey(b.from)) ||
      refKey(a.to).localeCompare(refKey(b.to)) ||
      a.kind.localeCompare(b.kind),
  );
}

export function createResourceCatalogue(snapshot: ResourceSnapshot): ResourceCatalogue {
  const entries = entryRecords(snapshot);
  const { packages, artifacts } = packageAndArtifactIndexes(entries);
  const sourcePackages = [...packages.values()].flatMap((item) => {
    const entry = entries.get(entryKey(item.ref.entry));
    return item.ref.kind === "package" && entry?.view.ref.kind === "source" && entry.evidence.status === "observed"
      ? [
          {
            ref: item.ref,
            label: item.record.label,
            pkg: item.pkg,
            artifacts: entry.evidence.observation.inventory.artifacts,
          },
        ]
      : [];
  });
  const projectGroups = new Map<string, readonly ProjectSkillGroup[]>();
  const projectSkillGroups = (entry: EntryRef): readonly ProjectSkillGroup[] => {
    if (entry.kind !== "project") return [];
    const key = entryKey(entry);
    const cached = projectGroups.get(key);
    if (cached) return cached;
    const indexed = entries.get(key);
    if (indexed?.evidence.status !== "observed" || !sameEntry(indexed.evidence.observation.subject, entry)) return [];
    const groups = createProjectSkillGroupsFromObservations({
      projectId: entry.id,
      observation: indexed.evidence.observation,
      bindings: snapshot.uses,
      sourcePackages,
    });
    projectGroups.set(key, groups);
    return groups;
  };
  const allRecords = sorted([
    ...[...entries.values()].map((item) => item.record),
    ...[...packages.values()].map((item) => item.record),
    ...[...artifacts.values()].map((item) => item.record),
  ]);
  const rootFor = (ref: ResourceRef): IndexedEntry | undefined => entries.get(entryKey(ref.entry));
  const childrenFor = (ref: ResourceRef): ResourceRecord[] => {
    const entry = rootFor(ref);
    if (!entry || entry.evidence.status !== "observed") return [];
    if (ref.kind === "entry") {
      const observedPackages = [...packages.values()]
        .filter((item) => sameEntry(item.ref.entry, ref.entry))
        .map((item) => item.record);
      const packageArtifactIds = new Set(
        [...packages.values()]
          .filter((item) => sameEntry(item.ref.entry, ref.entry))
          .flatMap((item) => item.pkg.artifactIds),
      );
      const loose = [...artifacts.values()]
        .filter(
          (item) =>
            sameEntry(item.ref.entry, ref.entry) &&
            (!item.artifact.packageId || !packageArtifactIds.has(item.artifact.id)),
        )
        .map((item) => item.record);
      return sorted([...observedPackages, ...loose]);
    }
    if (ref.kind === "package")
      return sorted([...artifacts.values()].filter((item) => refEqual(item.parent, ref)).map((item) => item.record));
    return childrenFor(artifacts.get(refKey(ref))?.parent ?? { kind: "entry", entry: ref.entry });
  };
  const inspect = (ref: ResourceRef): ResourceDetails | null => {
    const entry = rootFor(ref);
    if (!entry) return null;
    const observation =
      entry.evidence.status === "observed" && sameEntry(entry.evidence.observation.subject, ref.entry)
        ? entry.evidence.observation
        : undefined;
    let resource: ResourceRecord | undefined;
    let parent: ResourceRef | undefined;
    let files: ResourceDetails["files"] = [];
    let pkg: ObservedPackage | undefined;
    let artifact: ObservedArtifact | undefined;
    let packageFormat: ResourceDetails["packageFormat"];
    if (ref.kind === "entry") {
      resource = entry.record;
      const readme = observation?.inventory.marketplace?.readmePath;
      if (readme && ref.entry.kind === "source") files = [{ relativePath: readme, role: "readme" }];
    } else if (ref.kind === "package") {
      const item = packages.get(refKey(ref));
      if (!item) return null;
      resource = item.record;
      parent = { kind: "entry", entry: ref.entry };
      pkg = item.pkg;
      packageFormat = item.pkg.format;
      files = [
        ...item.pkg.manifestPaths.map((relativePath) => ({ relativePath, role: "support" as const })),
        ...(item.pkg.readmePath ? [{ relativePath: item.pkg.readmePath, role: "readme" as const }] : []),
        ...(observation?.inventory.artifacts
          .filter((value) => value.packageId === ref.packageId)
          .flatMap((value) =>
            observedPaths(value).map((relativePath) => ({ relativePath, role: "content" as const })),
          ) ?? []),
      ];
    } else {
      const item = artifacts.get(refKey(ref));
      if (!item) return null;
      resource = item.record;
      parent = item.parent;
      artifact = item.artifact;
      pkg = artifact.packageId
        ? observation?.inventory.packages?.find((value) => value.id === artifact?.packageId)
        : undefined;
      const projections = observation?.inventory.artifacts.filter(
        (value) =>
          value.kind === artifact?.kind &&
          value.packageId === artifact?.packageId &&
          value.physicalIdentity === artifact?.physicalIdentity,
      ) ?? [artifact];
      const main = projections.flatMap((value) =>
        observedPaths(value).map((relativePath) => ({ relativePath, role: "content" as const })),
      );
      const folders = main.map((file) => file.relativePath.replace(/\/SKILL\.md$/i, ""));
      const supports =
        artifact.kind === "skill"
          ? (observation?.inventory.artifacts
              .filter(
                (value) =>
                  value.id !== artifact?.id &&
                  value.packageId === artifact?.packageId &&
                  observedPaths(value).some((path) => folders.some((folder) => containsPath(folder, path))),
              )
              .flatMap((value) =>
                observedPaths(value).map((relativePath) => ({ relativePath, role: "support" as const })),
              ) ?? [])
          : [];
      files = [...main, ...supports];
    }
    const uses = relatedBindings(snapshot, ref, artifact, pkg);
    const skillOrigins =
      artifact?.kind === "skill" && observation ? projectSkillOriginsForArtifact(observation, artifact) : [];
    const membershipIssues =
      artifact?.kind === "skill" && ref.entry.kind === "project"
        ? projectSkillMembershipIssuesForArtifact(projectSkillGroups(ref.entry), ref)
        : [];
    return {
      resource,
      ...(parent ? { parent } : {}),
      diagnostics: observation?.inventory.diagnostics ?? [],
      files: uniqueFiles(files),
      uses,
      ...(packageFormat ? { packageFormat } : {}),
      ...(skillOrigins.length > 0 ? { skillOrigins } : {}),
      ...(membershipIssues.length > 0 ? { membershipIssues } : {}),
    };
  };
  const browse = (context: ResourceContext): ResourceListing => {
    if (context.kind === "workspace") {
      const children = sorted([...entries.values()].map((item) => item.record));
      const observedCount = [...entries.values()].filter((item) => item.evidence.status === "observed").length;
      const statuses = [...entries.values()].map((item) => item.evidence.status);
      const status: ResourceListing["status"] =
        statuses.length === 0
          ? "ready"
          : observedCount === 0
            ? statuses.every((value) => value === "loading")
              ? "loading"
              : statuses.some((value) => value === "unavailable")
                ? "unavailable"
                : "unobserved"
            : statuses.some((value) => value !== "observed") ||
                [...entries.values()].some((item) => listingStatus(item) === "partial")
              ? "partial"
              : "ready";
      const activeBindings =
        snapshot.uses.status === "ready"
          ? snapshot.uses.bindings.filter(
              (binding) =>
                entries.has(entryKey({ kind: "source", id: binding.sourceId })) &&
                entries.has(entryKey({ kind: "project", id: binding.projectId })),
            )
          : [];
      return { status, context, children, relations: sortRelations(useRelation(activeBindings)) };
    }
    if (context.kind === "artifact") {
      const item = artifacts.get(refKey(context));
      if (!item) return { status: "not-found", context, children: [], relations: [] };
      return browse(item.parent);
    }
    const entry = rootFor(context);
    const center = context.kind === "entry" ? entry?.record : packages.get(refKey(context))?.record;
    if (!entry || !center || (context.kind === "package" && !packages.has(refKey(context))))
      return { status: "not-found", context, children: [], relations: [] };
    const children = childrenFor(context);
    const status = context.kind === "entry" ? listingStatus(entry) : listingStatus(entry);
    return {
      status,
      context,
      center,
      children,
      relations: sortRelations([
        ...children.map((child): ResourceRelation => ({
          from: center.ref,
          to: child.ref,
          kind: "contains",
          bindingIds: [],
        })),
      ]),
    };
  };
  return {
    browse,
    inspect,
    search(query: string): readonly ResourceRecord[] {
      const needle = query.trim().toLocaleLowerCase();
      return allRecords.filter(
        (record) => !needle || `${record.label} ${record.relativePath ?? ""}`.toLocaleLowerCase().includes(needle),
      );
    },
    projectSkillGroups,
  };
}
