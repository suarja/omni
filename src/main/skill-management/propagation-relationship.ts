import type { Binding } from "../../domain/assignment-plan";
import type { InventorySnapshot } from "../../domain/inventory";
import type {
  ManagedSkillUse,
  SkillLocationKey,
  SkillRelationshipsState,
} from "../../domain/skill-reconciliation/types";
import type { SkillPropagationIntent } from "../../shared/skill-propagation-ipc";
import { skillLocationIdentity as locationKey } from "../../domain/skill-reconciliation/legacy-binding-bridge";
import { resolveLegacyBindingSource } from "./legacy-binding-source";

export function sourceMatches(left: ManagedSkillUse["source"], right: SkillPropagationIntent["source"]): boolean {
  return (
    left.sourceId === right.sourceId && left.packageId === right.packageId && left.artifactPath === right.artifactPath
  );
}

function bindingMatches(
  binding: Binding | undefined,
  use: ManagedSkillUse,
  location: SkillLocationKey,
  inventory: InventorySnapshot,
): binding is Binding {
  if (
    !binding ||
    binding.bindingId !== use.bindingId ||
    binding.kind !== "skill" ||
    binding.projectId !== location.projectId ||
    binding.harnessId !== location.harnessId
  )
    return false;
  const resolved = resolveLegacyBindingSource(binding, inventory);
  return resolved.status === "resolved" && sourceMatches(use.source, resolved.source);
}

export function validateTargetRelationship(
  source: SkillPropagationIntent["source"],
  location: SkillLocationKey,
  skillId: string | undefined,
  uses: readonly ManagedSkillUse[],
  bindings: readonly Binding[],
  skills: readonly SkillRelationshipsState["skills"][number][],
  inventory: InventorySnapshot,
): Readonly<{ use?: ManagedSkillUse; binding?: Binding; reason?: string }> {
  const matchingUses = uses.filter((use) => locationKey(use.location) === locationKey(location));
  if (matchingUses.length !== 1)
    return {
      reason: matchingUses.length
        ? "The target has contradictory managed-use records."
        : "The target is not linked to this skill.",
    };
  const use = matchingUses[0]!;
  const matchingBindings = bindings.filter((binding) => binding.bindingId === use.bindingId);
  if (
    (skillId !== undefined && use.skillId !== skillId) ||
    !sourceMatches(use.source, source) ||
    !skills.some(
      (record) =>
        record.skillId === use.skillId && record.locations.some((item) => locationKey(item) === locationKey(location)),
    ) ||
    matchingBindings.length !== 1 ||
    !bindingMatches(matchingBindings[0], use, location, inventory)
  )
    return { use, reason: "The exact relationship and Binding records do not agree." };
  return { use, binding: matchingBindings[0] };
}
