import type { Binding } from "../../domain/assignment-plan";
import { resolveTarget } from "../../domain/harness-targets";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { SkillDetachmentEvidence } from "../../shared/skill-detachment-effects";
import type { SkillDetachmentSnapshot } from "./detachment-reader";

type ReadySnapshot = Extract<SkillDetachmentSnapshot, { status: "ready" }>;
type Progress = Readonly<{ bindings: "pending" | "applied"; uses: "pending" | "applied" }>;

export type SkillDetachmentRecoveryDecision =
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "unchanged"; stateKey: string }>
  | Readonly<{ status: "restore"; restoreBinding: boolean; restoreUse: boolean; stateKey: string }>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function locationKey(location: SkillDetachmentEvidence["local"]["location"]): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function targetFolder(binding: Binding): string | undefined {
  if (binding.kind !== "skill") return undefined;
  const artifact = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const id = artifact.split("/").at(-1);
  if (!id) return undefined;
  const resolved = resolveTarget({ kind: "skill", id, harnessId: binding.harnessId });
  return resolved.status === "target" ? resolved.relativePath : undefined;
}

export function detachmentRecoveryStateKey(snapshot: ReadySnapshot, evidence: SkillDetachmentEvidence): string {
  const location = evidence.local.location;
  return canonical({
    rootIdentity: snapshot.rootIdentity,
    revision: snapshot.localTree.revision,
    envelope: snapshot.envelope,
    record: snapshot.record,
    selectedUses: snapshot.relationships.uses.filter((use) => locationKey(use.location) === locationKey(location)),
    bindings: snapshot.bindings,
  });
}

function targetBindings(snapshot: ReadySnapshot, evidence: SkillDetachmentEvidence): readonly Binding[] {
  return snapshot.bindings.filter(
    (binding) =>
      binding.projectId === evidence.local.location.projectId &&
      binding.harnessId === evidence.local.location.harnessId &&
      targetFolder(binding) === evidence.local.location.folderPath,
  );
}

export function planSkillDetachmentRecovery(
  args: Readonly<{
    snapshot: ReadySnapshot;
    evidence: SkillDetachmentEvidence;
    baseMatches: boolean;
    progress?: Progress;
    inverse?: Readonly<{ step: SkillEffectStep; progress?: Progress }>;
  }>,
): SkillDetachmentRecoveryDecision {
  const { snapshot, evidence } = args;
  const location = evidence.local.location;
  const record = snapshot.record;
  if (
    snapshot.rootIdentity !== evidence.local.rootIdentity ||
    !same(snapshot.localTree.revision, evidence.local.revision) ||
    !same(snapshot.envelope, evidence.local.envelope)
  ) {
    return {
      status: "blocked",
      reason: "The selected project copy changed after stop management; its old inverse is withheld.",
    };
  }
  if (
    !record ||
    record.skillId !== evidence.skillId ||
    !record.locations.some((member) => locationKey(member) === locationKey(location))
  ) {
    return { status: "blocked", reason: "The selected location no longer belongs to the original logical skill." };
  }
  if (!args.baseMatches) return { status: "blocked", reason: "The original immutable base is missing or changed." };

  const locationUses = snapshot.relationships.uses.filter((use) => locationKey(use.location) === locationKey(location));
  if (locationUses.length > 1 || (locationUses[0] && !same(locationUses[0], evidence.use)))
    return { status: "blocked", reason: "The selected location has a conflicting or late managed-use claim." };
  const usePresent = locationUses.length === 1;
  const targetClaims = targetBindings(snapshot, evidence);
  if (targetClaims.length > 1 || (targetClaims[0] && !same(targetClaims[0], evidence.binding)))
    return { status: "blocked", reason: "The selected target has a competing or changed Binding claim." };
  const bindingPresent = targetClaims.length === 1;

  const peerUses = snapshot.relationships.uses.filter((use) => use.skillId === evidence.skillId);
  if (peerUses.some((use) => !same(use.source, evidence.use.source)))
    return { status: "blocked", reason: "Another use now links this logical skill to a different source." };
  if (args.inverse) {
    const progress = args.inverse.progress ?? { bindings: "pending", uses: "pending" };
    const bindingBefore = args.inverse.step.bindingEffects[0]?.before !== undefined;
    const useBefore = args.inverse.step.metadataEffects?.[0]?.before !== undefined;
    const expectedBinding = progress.bindings === "applied" || bindingBefore;
    const expectedUse = progress.uses === "applied" || useBefore;
    if (bindingPresent !== expectedBinding || usePresent !== expectedUse)
      return {
        status: "blocked",
        reason: "Inverse metadata changed without matching durable acknowledgment; recovery is withheld.",
      };
    return {
      status: "restore",
      restoreBinding: !bindingPresent,
      restoreUse: !usePresent,
      stateKey: detachmentRecoveryStateKey(snapshot, evidence),
    };
  }
  if (bindingPresent && !usePresent)
    return { status: "blocked", reason: "The original Binding exists without its original managed use." };
  const progress = args.progress ?? { bindings: "pending", uses: "pending" };
  if ((bindingPresent && progress.bindings === "applied") || (usePresent && progress.uses === "applied"))
    return { status: "blocked", reason: "Acknowledged stop-management progress conflicts with current metadata." };
  const restoreBinding = !bindingPresent;
  const restoreUse = !usePresent;
  if ((restoreBinding && progress.bindings !== "applied") || (restoreUse && progress.uses !== "applied"))
    return {
      status: "blocked",
      reason: "A tracking write is missing without a durable acknowledgment; recovery will not guess what was applied.",
    };
  if (!restoreBinding && !restoreUse)
    return { status: "unchanged", stateKey: detachmentRecoveryStateKey(snapshot, evidence) };
  return {
    status: "restore",
    restoreBinding,
    restoreUse,
    stateKey: detachmentRecoveryStateKey(snapshot, evidence),
  };
}
