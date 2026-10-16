import type { Binding } from "../../../domain/assignment-plan";
import type { ManagedSkillUse, SkillLocationKey, SourceSkillRef } from "../../../domain/skill-reconciliation/types";
import type { SkillIntent } from "../../../shared/skill-management-ipc";

export type CopyManagementAction = "keep" | "link" | "canonical" | "capture" | "detach";
export type CopyManagementReview =
  | Readonly<{ kind: "local-no-write" }>
  | Readonly<{ kind: "operation"; intent: Extract<SkillIntent, { kind: "reconcile" }> }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type CopyManagementReviewInput = Readonly<{
  action: CopyManagementAction | "";
  skillId: string;
  location: SkillLocationKey;
  readable: boolean;
  usesStatus: "ready" | "loading" | "unavailable";
  locationUse?: ManagedSkillUse;
  binding?: Binding;
  source?: SourceSkillRef;
  destination?: Readonly<{ sourceId: string; packageId: string }>;
  skillKey?: string;
}>;

export type CopyManagementCapabilityInput = Readonly<{
  skillId: string;
  location: SkillLocationKey;
  readable: boolean;
  usesStatus: "ready" | "loading" | "unavailable";
  locationUse?: ManagedSkillUse;
  binding?: Binding;
}>;

function sameLocation(left: SkillLocationKey, right: SkillLocationKey): boolean {
  return (
    left.projectId === right.projectId && left.harnessId === right.harnessId && left.folderPath === right.folderPath
  );
}

function matchingBinding(use: ManagedSkillUse, binding: Binding | undefined): boolean {
  return Boolean(
    binding &&
    binding.bindingId === use.bindingId &&
    binding.projectId === use.location.projectId &&
    binding.harnessId === use.location.harnessId &&
    binding.kind === "skill" &&
    binding.sourceId === use.source.sourceId &&
    binding.packageId === use.source.packageId &&
    (binding.artifactPath === use.source.artifactPath ||
      binding.artifactPath === `${use.source.artifactPath}/SKILL.md`),
  );
}

function validateContext(input: CopyManagementReviewInput): string | undefined {
  if (!input.readable) return "The selected copy is unavailable. Retry it or choose a readable copy.";
  if (input.usesStatus !== "ready") return "Management evidence is still loading or unavailable.";
  if (input.locationUse && input.locationUse.skillId !== input.skillId) {
    return "This location is managed under a different logical skill.";
  }
  if (input.locationUse && !sameLocation(input.locationUse.location, input.location)) {
    return "The recorded management relationship does not match the selected location.";
  }
  if (input.locationUse && !matchingBinding(input.locationUse, input.binding)) {
    return "The recorded management relationship has no matching Binding.";
  }
  return undefined;
}

function unavailable(reason: string): CopyManagementReview {
  return { kind: "unavailable", reason };
}

export function buildCopyManagementReview(input: CopyManagementReviewInput): CopyManagementReview {
  if (!input.action) return unavailable("Choose an action for the selected copy.");
  const problem = validateContext(input);
  if (problem) return unavailable(problem);

  const managed = input.locationUse !== undefined;
  if (input.action === "keep") {
    if (!managed) return { kind: "local-no-write" };
    return {
      kind: "operation",
      intent: {
        kind: "reconcile",
        request: { choice: "keep-local", skillId: input.skillId, locations: [input.location] },
      },
    };
  }
  if (input.action === "link") {
    if (managed) return unavailable("Choose a managed-copy action for this location.");
    if (!input.source) return unavailable("Choose an observed marketplace skill first.");
    return {
      kind: "operation",
      intent: {
        kind: "reconcile",
        request: {
          choice: "link-canonical",
          skillId: input.skillId,
          source: input.source,
          locations: [input.location],
        },
      },
    };
  }
  if (input.action === "canonical" || input.action === "detach") {
    if (!managed) return unavailable("This action requires a verified managed copy.");
    return {
      kind: "operation",
      intent: {
        kind: "reconcile",
        request:
          input.action === "canonical"
            ? { choice: "use-canonical", skillId: input.skillId, locations: [input.location] }
            : { choice: "detach-managed", skillId: input.skillId, locations: [input.location] },
      },
    };
  }
  if (!input.destination || !input.skillKey || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.skillKey)) {
    return unavailable("Choose a personal destination and a safe, available skill name.");
  }
  return {
    kind: "operation",
    intent: {
      kind: "reconcile",
      request: {
        choice: "keep-variant",
        skillId: input.skillId,
        locations: [input.location],
        destination: { ...input.destination, skillKey: input.skillKey },
      },
    },
  };
}

export function availableCopyManagementActions(input: CopyManagementCapabilityInput): readonly CopyManagementAction[] {
  if (!input.readable || input.usesStatus !== "ready") return ["keep"];
  if (input.locationUse?.skillId !== undefined && input.locationUse.skillId !== input.skillId) return ["keep"];
  if (input.locationUse?.skillId === input.skillId) {
    if (!sameLocation(input.locationUse.location, input.location) || !matchingBinding(input.locationUse, input.binding))
      return ["keep"];
    return ["keep", "canonical", "capture", "detach"];
  }
  return ["keep", "link", "capture"];
}
