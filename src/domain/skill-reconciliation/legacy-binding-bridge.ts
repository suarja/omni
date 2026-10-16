import type { Binding } from "../assignment-plan";
import { resolveTarget } from "../harness-targets";
import { artifactName } from "../identity";
import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRecordEffect,
  SkillRelationshipsState,
  SourceSkillRef,
} from "./types";

export type LegacyBindingCopy = Readonly<{
  binding: Binding;
  location: SkillLocationKey;
  source: SourceSkillRef;
  baseRevisionId: string;
  baseUnavailable?: true;
}>;

export function skillLocationIdentity(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

export function legacyBindingLocation(binding: Binding): SkillLocationKey | undefined {
  if (binding.kind !== "skill") return undefined;
  const id = artifactName({ kind: "skill", provenance: { relativePath: binding.artifactPath } });
  const target = resolveTarget({ kind: "skill", id, harnessId: binding.harnessId });
  return target.status === "target"
    ? { projectId: binding.projectId, harnessId: binding.harnessId, folderPath: target.relativePath }
    : undefined;
}

export function legacyBindingSource(binding: Binding): SourceSkillRef {
  return {
    sourceId: binding.sourceId,
    packageId: binding.packageId,
    artifactPath: binding.artifactPath.replace(/\/SKILL\.md$/u, ""),
  };
}

// Receipt replay validates representation consistency only. Eligibility separately resolves
// these aliases against the current inventory before any project write.
export function matchesBindingSourceRepresentation(binding: Binding, source: SourceSkillRef): boolean {
  const packageMatches =
    binding.packageId === source.packageId ||
    (!binding.packageId.includes("/") && source.packageId.endsWith(`/${binding.packageId}`)) ||
    (!source.packageId.includes("/") && binding.packageId.endsWith(`/${source.packageId}`));
  const folder = binding.artifactPath.replace(/\/SKILL\.md$/u, "");
  return (
    binding.sourceId === source.sourceId &&
    packageMatches &&
    [
      source.artifactPath,
      `${binding.packageId}/${source.artifactPath}`,
      `${source.packageId}/${source.artifactPath}`,
    ].includes(folder)
  );
}

function groupIdentity(copy: Readonly<{ location: SkillLocationKey; source: SourceSkillRef }>): string {
  return JSON.stringify([
    copy.location.projectId,
    copy.source.sourceId,
    copy.source.packageId,
    copy.source.artifactPath,
  ]);
}

function mergeGroup(
  skills: LogicalSkillRecord[],
  uses: readonly ManagedSkillUse[],
  group: readonly LegacyBindingCopy[],
  allocateId: () => string,
): string {
  const groupKey = groupIdentity(group[0]!);
  const linked = uses.filter((use) => groupIdentity(use) === groupKey);
  const linkedIds = new Set(linked.map(({ skillId }) => skillId));
  if (linkedIds.size > 1) throw new Error("Legacy copies already have contradictory managed identities.");
  const locations = [...linked.map(({ location }) => location), ...group.map(({ location }) => location)];
  const selected = new Set(locations.map(skillLocationIdentity));
  const candidates = skills.filter((skill) =>
    skill.locations.some((location) => selected.has(skillLocationIdentity(location))),
  );
  const existing = linkedIds.size
    ? skills.find(({ skillId }) => linkedIds.has(skillId))
    : candidates.find((skill) => skill.locations.every((location) => selected.has(skillLocationIdentity(location))));
  const skillId = existing?.skillId ?? allocateId();
  for (const candidate of candidates) {
    if (candidate.skillId === skillId) continue;
    const moved = candidate.locations.filter((location) => selected.has(skillLocationIdentity(location)));
    if (
      uses.some(
        (use) =>
          use.skillId === candidate.skillId &&
          moved.some((location) => skillLocationIdentity(location) === skillLocationIdentity(use.location)),
      )
    )
      throw new Error("Legacy copies overlap another managed skill; inspect the exact Binding location.");
    const remaining = candidate.locations.filter((location) => !selected.has(skillLocationIdentity(location)));
    const index = skills.findIndex((skill) => skill.skillId === candidate.skillId);
    if (remaining.length) skills[index] = { ...candidate, locations: remaining };
    else skills.splice(index, 1);
  }
  const unique = new Map(
    [...(existing?.locations ?? []), ...locations].map((location) => [skillLocationIdentity(location), location]),
  );
  const next: LogicalSkillRecord = {
    ...(existing ?? {
      skillId,
      label: group[0]!.source.artifactPath.split("/").at(-1)!,
      evidence: "individual" as const,
    }),
    locations: [...unique.values()],
  };
  const index = skills.findIndex((skill) => skill.skillId === skillId);
  if (index < 0) skills.push(next);
  else skills[index] = next;
  return skillId;
}

export function planLegacyBindingBridge(
  state: SkillRelationshipsState,
  copies: readonly LegacyBindingCopy[],
  allocateId: () => string,
): Readonly<{ uses: readonly ManagedSkillUse[]; records: readonly SkillRecordEffect[] }> {
  const skills = [...state.skills];
  const groups = new Map<string, LegacyBindingCopy[]>();
  for (const copy of copies) {
    const key = groupIdentity(copy);
    groups.set(key, [...(groups.get(key) ?? []), copy]);
  }
  const uses: ManagedSkillUse[] = [];
  for (const group of groups.values()) {
    const skillId = mergeGroup(skills, state.uses, group, allocateId);
    for (const copy of group)
      uses.push({
        skillId,
        bindingId: copy.binding.bindingId,
        location: copy.location,
        source: copy.source,
        baseRevisionId: copy.baseRevisionId,
        ...(copy.baseUnavailable ? { baseUnavailable: true } : {}),
      });
  }
  const before = new Map(state.skills.map((skill) => [skill.skillId, skill]));
  const after = new Map(skills.map((skill) => [skill.skillId, skill]));
  const records = [...new Set([...before.keys(), ...after.keys()])].flatMap((skillId): SkillRecordEffect[] => {
    const old = before.get(skillId),
      next = after.get(skillId);
    return JSON.stringify(old) === JSON.stringify(next)
      ? []
      : [{ skillId, ...(old ? { before: old } : {}), ...(next ? { after: next } : {}) }];
  });
  return { uses, records };
}
