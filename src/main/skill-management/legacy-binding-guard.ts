import type { Binding } from "../../domain/assignment-plan";
import { legacyBindingLocation, skillLocationIdentity } from "../../domain/skill-reconciliation/legacy-binding-bridge";
import type { ManagedSkillUse } from "../../domain/skill-reconciliation/types";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";

export function isManagedBinding(binding: Binding, uses: readonly ManagedSkillUse[]): boolean {
  const location = legacyBindingLocation(binding);
  return uses.some(
    (use) =>
      use.bindingId === binding.bindingId ||
      (location && skillLocationIdentity(use.location) === skillLocationIdentity(location)),
  );
}

export async function assertLegacyBindingsUnmanaged(
  bindings: readonly Binding[],
  relationships: SkillRelationshipStore,
): Promise<void> {
  const loaded = await relationships.read();
  if (loaded.status !== "ready")
    throw new Error("Skill relationships are unavailable; inspect the store before applying legacy assignments.");
  const managed = bindings.find((binding) => isManagedBinding(binding, loaded.state.uses));
  if (managed)
    throw new Error(
      `Binding ${managed.bindingId} in project ${managed.projectId} is managed by Omni; use Update linked copies or copy management in Changes.`,
    );
}
