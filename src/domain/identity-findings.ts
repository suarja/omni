import type { InventoryDiagnostic, ObservedPackage } from "./inventory";
import type { EntryRef } from "./project-source-registry";
import {
  artifactName,
  compare,
  entryKey,
  isSkillFolderLogicalId,
  MANIFEST_KINDS,
  REUSABLE_UNIT_KINDS,
  pathSegments,
  resolvePackage,
  rootKey,
  rootsKey,
  skillFolderPrefix,
  sortIdentities,
  stripExtension,
  uniqueRoots,
  type ArtifactIdentity,
  type IdentityFinding,
  type PhysicalIdentityLookup,
} from "./identity-findings-utils";
export { skillFolderPrefix } from "./identity-findings-utils";

/**
 * The key that identifies "the same example" for display purposes. A loose skill folder's harness
 * convention prefix (`.claude`, `.agents`, ...) is not part of the skill's identity, so two
 * conventions of the same skill share this key even though their logical ids differ; everything
 * else uses its logical id as-is.
 */
export function exampleGroupKey(identity: ArtifactIdentity): string {
  if (!identity.logicalId.startsWith("loose:") || !isSkillFolderLogicalId(identity.logicalId))
    return identity.logicalId;
  const segments = identity.logicalId.slice("loose:".length).split("/");
  return `loose-skill:${segments.slice(-2).join("/")}`;
}

/** Same logical artifact appearing on several roots (or harness conventions) collapses to a single representative. */
export function distinctByLogicalId(identities: readonly ArtifactIdentity[]): ArtifactIdentity[] {
  const seen = new Set<string>();
  const result: ArtifactIdentity[] = [];
  for (const identity of identities) {
    const key = exampleGroupKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(identity);
  }
  return result;
}

/** The directory segment right above the logical id's leaf, used to disambiguate a shared basename. */
export function parentSegment(logicalId: string): string | undefined {
  const colonIndex = logicalId.indexOf(":");
  const path = colonIndex === -1 ? logicalId : logicalId.slice(colonIndex + 1);
  const segments = path.split("/");
  return segments.length >= 2 ? segments.at(-2) : undefined;
}

/**
 * Up to three distinct display names for the renderer to surface as evidence. Artifacts that
 * share a logical id (the same item observed on several roots) collapse to one representative;
 * artifacts that merely share a basename (e.g. two unrelated `icon` files) are disambiguated with
 * their logical id's parent segment instead of being repeated.
 */
export function exampleNames(identities: readonly ArtifactIdentity[], packages: readonly ObservedPackage[]): string[] {
  const candidates = distinctByLogicalId(sortIdentities(identities)).map((identity) => ({
    identity,
    name: artifactName(identity, resolvePackage(identity, packages)),
  }));
  const nameCounts = new Map<string, number>();
  for (const { name } of candidates) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);

  const examples: string[] = [];
  const seenDisplayNames = new Set<string>();
  for (const { identity, name } of candidates) {
    const parent = (nameCounts.get(name) ?? 0) > 1 ? parentSegment(identity.logicalId) : undefined;
    const displayName = parent && parent !== name ? `${name} (${parent})` : name;
    if (seenDisplayNames.has(displayName)) continue;
    seenDisplayNames.add(displayName);
    examples.push(displayName);
    if (examples.length === 3) break;
  }
  return examples;
}

/**
 * Collapses artifacts that share the same physical file within one root (a projection such as
 * `AGENTS.md` mirroring `CLAUDE.md`) into a single representative identity, so projections are
 * never mistaken for duplicates of one another.
 */
export function dedupeByPhysicalIdentity(
  identities: readonly ArtifactIdentity[],
  physicalIdentities?: PhysicalIdentityLookup,
): ArtifactIdentity[] {
  const seen = new Set<string>();
  const result: ArtifactIdentity[] = [];
  for (const identity of identities) {
    const physicalIdentity = physicalIdentities?.get(identity.artifactId) ?? identity.provenance.relativePath;
    const key = `${rootKey(identity)}:${physicalIdentity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(identity);
  }
  return result;
}

export function isDirectoryArtifact(identity: ArtifactIdentity): boolean {
  const path = identity.provenance.relativePath.replaceAll("\\", "/");
  return (
    isSkillFolderLogicalId(identity.logicalId) && !path.endsWith("/SKILL.md") && !path.split("/").at(-1)?.includes(".")
  );
}

/** Removes a whole-folder projection when another identity already describes a member of that folder. */
export function collapsePhysicalProjections(
  identities: readonly ArtifactIdentity[],
  physicalIdentities?: PhysicalIdentityLookup,
): readonly ArtifactIdentity[] {
  const deduped = dedupeByPhysicalIdentity(identities, physicalIdentities);
  return deduped.filter((identity) => {
    if (!isDirectoryArtifact(identity)) return true;
    const physicalIdentity = physicalIdentities?.get(identity.artifactId) ?? identity.provenance.relativePath;
    return !deduped.some((candidate) => {
      if (candidate === identity || rootKey(candidate) !== rootKey(identity)) return false;
      const candidatePhysicalIdentity =
        physicalIdentities?.get(candidate.artifactId) ?? candidate.provenance.relativePath;
      return candidatePhysicalIdentity.startsWith(`${physicalIdentity}/`);
    });
  });
}

export function excludeManifests(identities: readonly ArtifactIdentity[]): ArtifactIdentity[] {
  return identities.filter((identity) => !MANIFEST_KINDS.has(identity.kind));
}

/**
 * A member's path relative to its own skill folder (e.g. `.claude/skills/x/references/a.md` and
 * `.agents/skills/x/references/a.md` both resolve to `references/a.md`), so the same skill folder
 * hashes identically no matter which harness convention hosts it.
 */
export function relativePathInsideSkillFolder(identity: ArtifactIdentity): string {
  const path = identity.provenance.relativePath.replaceAll("\\", "/");
  const prefix = skillFolderPrefix(path);
  return prefix ? path.slice(prefix.length + 1) : path;
}

/**
 * The deterministic joined string of every member's `relativePathInsideFolder:memberHash`, sorted
 * and newline joined, used purely as a *grouping key* — never surfaced as a finding's content
 * hash. It both varies with content (any changed file hash changes the key) and with structure (a
 * file added, removed, or renamed inside the folder changes the key) — while staying invariant to
 * the folder's own path prefix, so the same folder matches across harness conventions.
 */
export function skillFolderGroupKey(sorted: readonly ArtifactIdentity[]): string {
  return sorted.map((member) => `${relativePathInsideSkillFolder(member)}:${member.contentHash}`).join("\n");
}

/**
 * One candidate unit for exact-duplicate grouping: either a single-file artifact (grouped by its
 * own real content hash) or a folded skill folder (grouped by `skillFolderGroupKey`, which is not
 * a real hash and never surfaces as a finding's `contentHash`).
 */
type ExactDuplicateUnit = Readonly<{
  identity: ArtifactIdentity;
  groupKey: string;
  isFolderUnit: boolean;
}>;

/**
 * Collapses every file inside one skill folder (same root, same folder logical id) into a single
 * representative unit, so a skill folder counts as one exact-duplicate unit rather than one per
 * file it happens to contain. The representative groups on the combined key of every file's hash
 * in folder order, so two roots only match when every file in the folder matches. Non-skill
 * artifacts pass through untouched — they stay single-file units grouped by their own hash.
 */
export function foldSkillFoldersForExactDuplicate(identities: readonly ArtifactIdentity[]): ExactDuplicateUnit[] {
  const folders = new Map<string, ArtifactIdentity[]>();
  const singles: ExactDuplicateUnit[] = [];
  for (const identity of identities) {
    if (!isSkillFolderLogicalId(identity.logicalId)) {
      singles.push({ identity, groupKey: identity.contentHash, isFolderUnit: false });
      continue;
    }
    const key = `${rootKey(identity)}:${identity.logicalId}`;
    folders.set(key, [...(folders.get(key) ?? []), identity]);
  }
  const representatives = [...folders.values()].map((members) => {
    const sorted = sortIdentities(members);
    return { identity: sorted[0]!, groupKey: skillFolderGroupKey(sorted), isFolderUnit: true };
  });
  return [...singles, ...representatives];
}

/** Basenames (extension stripped) inside a skill folder whose content is not identical across every root that has it. */
export function differingSkillFolderBasenames(group: readonly ArtifactIdentity[]): string[] {
  const totalRoots = new Set(group.map(rootKey)).size;
  const byBasename = new Map<string, { hashes: Set<string>; roots: Set<string> }>();
  for (const identity of group) {
    const basename = stripExtension(
      pathSegments(identity.provenance.relativePath).at(-1) ?? identity.provenance.relativePath,
    );
    const entry = byBasename.get(basename) ?? { hashes: new Set<string>(), roots: new Set<string>() };
    entry.hashes.add(identity.contentHash);
    entry.roots.add(rootKey(identity));
    byBasename.set(basename, entry);
  }
  return [...byBasename.entries()]
    .filter(([, entry]) => entry.hashes.size > 1 || entry.roots.size < totalRoots)
    .map(([basename]) => basename)
    .sort(compare)
    .slice(0, 3);
}

export function exactDuplicateFindings(
  identities: readonly ArtifactIdentity[],
  packages: readonly ObservedPackage[],
): IdentityFinding[] {
  const hashGroups = new Map<string, ExactDuplicateUnit[]>();
  for (const unit of foldSkillFoldersForExactDuplicate(excludeManifests(identities))) {
    hashGroups.set(unit.groupKey, [...(hashGroups.get(unit.groupKey) ?? []), unit]);
  }
  const duplicateGroups = [...hashGroups.values()].filter((group) => group.length > 1);

  const byRootsKey = new Map<string, { roots: readonly EntryRef[]; groups: ExactDuplicateUnit[][] }>();
  for (const group of duplicateGroups) {
    const roots = uniqueRoots(group.map((unit) => unit.identity));
    const key = rootsKey(roots);
    const bucket = byRootsKey.get(key) ?? { roots, groups: [] };
    bucket.groups.push(group);
    byRootsKey.set(key, bucket);
  }

  return [...byRootsKey.values()].map(({ roots, groups }) => {
    const allArtifacts = groups.flat().map((unit) => unit.identity);
    // The finding's contentHash is a real sha256 the renderer can show as evidence, so it is only
    // ever set for a single unambiguous group of single-file duplicates — never for a folded
    // skill folder, whose groupKey is not a real hash.
    const singleGroup = groups.length === 1 ? groups[0]! : undefined;
    const contentHash = singleGroup && !singleGroup[0]!.isFolderUnit ? singleGroup[0]!.identity.contentHash : undefined;
    return {
      kind: "exact-duplicate" as const,
      severity: "info" as const,
      roots,
      count: groups.length,
      examples: exampleNames(allArtifacts, packages),
      ...(contentHash ? { contentHash } : {}),
    };
  });
}

/**
 * A variant is a per-item decision about a reusable unit — never for prose that is expected to
 * differ per project (instructions, rules, manifests) or for a kind this domain doesn't yet name.
 * A skill folder is always eligible: it names a reusable skill even when the differing file inside
 * it (e.g. a reference doc) is not itself classified as `skill`.
 */
export function isVariantEligible(identity: ArtifactIdentity): boolean {
  return isSkillFolderLogicalId(identity.logicalId) || REUSABLE_UNIT_KINDS.has(identity.kind);
}

export function variantFindings(
  identities: readonly ArtifactIdentity[],
  packages: readonly ObservedPackage[],
): IdentityFinding[] {
  const groups = new Map<string, ArtifactIdentity[]>();
  for (const identity of identities.filter(isVariantEligible)) {
    const packageInfo = resolvePackage(identity, packages);
    const skillFolder = isSkillFolderLogicalId(identity.logicalId);
    const key = packageInfo
      ? `packaged:${identity.logicalId}`
      : skillFolder
        ? `loose-skill:${identity.logicalId}`
        : `loose:${identity.kind}:${artifactName(identity, packageInfo)}`;
    groups.set(key, [...(groups.get(key) ?? []), identity]);
  }

  return [...groups.values()].flatMap((group) => {
    if (new Set(group.map(rootKey)).size < 2) return [];
    if (isSkillFolderLogicalId(group[0]!.logicalId)) {
      // A skill folder is one logical unit: compare the set of file hashes across roots, not
      // per-file, and name only the basenames that actually differ.
      const differing = differingSkillFolderBasenames(group);
      if (differing.length === 0) return [];
      return [
        {
          kind: "variant" as const,
          severity: "warning" as const,
          roots: uniqueRoots(group),
          count: group.length,
          examples: differing,
          logicalId: group[0]!.logicalId,
        },
      ];
    }
    if (new Set(group.map((item) => item.contentHash)).size < 2) return [];
    return [
      {
        kind: "variant" as const,
        severity: "warning" as const,
        roots: uniqueRoots(group),
        count: group.length,
        examples: exampleNames(group, packages),
        logicalId: group[0]!.logicalId,
      },
    ];
  });
}

export function unsupportedFindings(
  identities: readonly ArtifactIdentity[],
  packages: readonly ObservedPackage[],
  diagnostics: readonly InventoryDiagnostic[],
): IdentityFinding[] {
  return packages.flatMap((packageInfo) => {
    const manifestDiagnostic = diagnostics.find(
      (diagnostic) =>
        packageInfo.manifestPaths.includes(diagnostic.location) &&
        (diagnostic.severity === "warning" || diagnostic.severity === "error"),
    );
    if (!manifestDiagnostic) return [];
    const identity = identities.find((candidate) => candidate.provenance.packageId === packageInfo.id);
    if (!identity) return [];
    return [
      {
        kind: "unsupported-format" as const,
        severity: "warning" as const,
        roots: [identity.provenance.root],
        count: 1,
        examples: exampleNames([identity], packages),
        packageId: packageInfo.id,
      },
    ];
  });
}

export function looseFindings(
  identities: readonly ArtifactIdentity[],
  packages: readonly ObservedPackage[],
): IdentityFinding[] {
  // Project roots never get an "unmanaged" grouping here — that belongs to Brief 10's
  // project-side grouping. Only source roots surface a loose finding.
  const eligible = excludeManifests(identities).filter(
    (identity) => identity.provenance.packageId === undefined && identity.provenance.root.kind === "source",
  );
  const byRoot = new Map<string, ArtifactIdentity[]>();
  for (const identity of eligible) {
    const key = rootKey(identity);
    byRoot.set(key, [...(byRoot.get(key) ?? []), identity]);
  }
  return [...byRoot.values()].map((group) => {
    const sorted = sortIdentities(group);
    return {
      kind: "loose" as const,
      severity: "info" as const,
      roots: [sorted[0]!.provenance.root],
      count: sorted.length,
      examples: exampleNames(sorted, packages),
    };
  });
}

export function compareFindings(left: IdentityFinding, right: IdentityFinding): number {
  return (
    compare(left.kind, right.kind) ||
    compare(rootsKey(left.roots), rootsKey(right.roots)) ||
    compare(left.logicalId ?? "", right.logicalId ?? "")
  );
}

export function deriveIdentityFindings(
  identities: readonly ArtifactIdentity[],
  packages: readonly ObservedPackage[],
  diagnostics: readonly InventoryDiagnostic[],
  physicalIdentities?: PhysicalIdentityLookup,
): readonly IdentityFinding[] {
  const deduped = collapsePhysicalProjections(identities, physicalIdentities);
  const findings = [
    ...exactDuplicateFindings(deduped, packages),
    ...variantFindings(deduped, packages),
    ...unsupportedFindings(deduped, packages, diagnostics),
    ...looseFindings(deduped, packages),
  ];
  return findings.sort(compareFindings);
}
