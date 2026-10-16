import { createHash } from "node:crypto";

import { resolveTarget } from "../harness-targets";
import type { Binding } from "../assignment-plan";
import type { SkillEffectFingerprint } from "../skill-management-intent";
import type { SkillBindingEffect, SkillScope } from "../../shared/skill-management-ipc";
import type { SkillDetachmentEvidence } from "../../shared/skill-detachment-effects";
import type { SkillDetachmentRequest } from "../../shared/skill-detachment-request";
import type { LogicalSkillRecord, ManagedSkillUse, SkillLocationKey, SkillRevision, SkillUseEffect } from "./types";
import type { SkillDirectoryEnvelope } from "../../shared/skill-directory-envelope";

type LocalEvidence = Readonly<{
  location: SkillLocationKey;
  rootIdentity: string;
  revision: SkillRevision;
  envelope: SkillDirectoryEnvelope;
}>;

type BaseEvidence = Readonly<{ baseRevisionId: string; revision: SkillRevision }>;

export type SkillDetachmentPolicyInput = Readonly<{
  request: SkillDetachmentRequest;
  record: LogicalSkillRecord | undefined;
  storeRevision: number;
  local: LocalEvidence;
  use: ManagedSkillUse | undefined;
  binding: Binding | undefined;
  base: BaseEvidence | undefined;
  bindings: readonly Binding[];
  uses: readonly ManagedSkillUse[];
  intentId: string;
}>;

export type SkillDetachmentPlan =
  | Readonly<{
      status: "ready";
      stepId: string;
      evidence: SkillDetachmentEvidence;
      scope: SkillScope;
      files: readonly [];
      actions: readonly [];
      bindingEffects: readonly SkillBindingEffect[];
      metadataEffects: readonly SkillUseEffect[];
      fingerprint: SkillEffectFingerprint;
    }>
  | Readonly<{ status: "blocked" | "needs-input"; code: string; reason: string }>;

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function blocked(code: string, reason: string): SkillDetachmentPlan {
  return { status: "blocked", code, reason };
}

function needsInput(code: string, reason: string): SkillDetachmentPlan {
  return { status: "needs-input", code, reason };
}

function bindingFolder(binding: Binding): string | undefined {
  if (binding.kind !== "skill" || !binding.artifactPath) return undefined;
  const artifact = binding.artifactPath.endsWith("/SKILL.md")
    ? binding.artifactPath.slice(0, -"/SKILL.md".length)
    : binding.artifactPath;
  const id = artifact.split("/").at(-1);
  if (!id) return undefined;
  const target = resolveTarget({ kind: "skill", id, harnessId: binding.harnessId });
  return target.status === "target" ? target.relativePath : undefined;
}

function bindingMatches(binding: Binding, use: ManagedSkillUse, location: SkillLocationKey): boolean {
  return (
    binding.bindingId === use.bindingId &&
    binding.kind === "skill" &&
    binding.projectId === location.projectId &&
    binding.harnessId === location.harnessId &&
    binding.sourceId === use.source.sourceId &&
    binding.packageId === use.source.packageId &&
    (binding.artifactPath === use.source.artifactPath || binding.artifactPath === `${use.source.artifactPath}/SKILL.md`)
  );
}

function expectedFolder(use: ManagedSkillUse): string | undefined {
  const artifactParts = use.source.artifactPath.split("/");
  const id = artifactParts.at(-1);
  if (!id || artifactParts.length < 2) return undefined;
  const target = resolveTarget({ kind: "skill", id, harnessId: use.location.harnessId });
  return target.status === "target" ? target.relativePath : undefined;
}

function childStepId(intentId: string, location: SkillLocationKey): string {
  const path = locationKey(location);
  const suffix = createHash("sha256").update(`${intentId}\n${path}`, "utf8").digest("hex").slice(0, 32);
  return `detach-${suffix}`;
}

export function planSkillDetachment(input: SkillDetachmentPolicyInput): SkillDetachmentPlan {
  const location = input.request.locations[0];
  if (input.request.choice !== "detach-managed" || input.request.locations.length !== 1 || !location)
    return blocked("selection-invalid", "Stop management requires one exact selected location.");
  if (
    !input.record ||
    input.record.skillId !== input.request.skillId ||
    !input.record.locations.some((member) => locationKey(member) === locationKey(location))
  ) {
    return blocked("location-not-in-skill", "The selected copy no longer belongs to this logical skill.");
  }
  if (!Number.isSafeInteger(input.storeRevision) || input.storeRevision < 0)
    return needsInput("relationships-unavailable", "Fresh skill relationship state is unavailable.");
  if (
    typeof input.local.rootIdentity !== "string" ||
    input.local.rootIdentity.length !== 64 ||
    !/^[a-f0-9]{64}$/u.test(input.local.rootIdentity) ||
    !same(input.local.location, location) ||
    !input.local.envelope.some((entry) => entry.path === "." && entry.kind === "directory")
  ) {
    return needsInput("project-observation-unavailable", "The selected project copy could not be verified safely.");
  }

  const locationUses = input.uses.filter((use) => locationKey(use.location) === locationKey(location));
  const targetBindings = input.bindings.filter(
    (binding) =>
      binding.projectId === location.projectId &&
      binding.harnessId === location.harnessId &&
      bindingFolder(binding) === location.folderPath,
  );
  if (!input.use) {
    if (locationUses.length || targetBindings.length)
      return blocked(
        "management-contradiction",
        "The selected copy has tracking claims that do not match a managed use.",
      );
    return needsInput(
      "management-absent",
      "The selected copy is no longer managed; refresh before choosing an action.",
    );
  }
  if (!input.binding || !input.base)
    return needsInput(
      "management-evidence-incomplete",
      "The selected managed copy or its immutable base is unavailable.",
    );
  if (
    locationUses.length !== 1 ||
    !same(locationUses[0], input.use) ||
    locationKey(input.use.location) !== locationKey(location) ||
    input.use.skillId !== input.request.skillId
  ) {
    return blocked("management-contradiction", "The selected copy has a conflicting managed-use claim.");
  }
  if (targetBindings.length !== 1 || !same(targetBindings[0], input.binding))
    return blocked("binding-ambiguous", "The selected project location has a missing or competing Binding.");
  if (
    !bindingMatches(input.binding, input.use, location) ||
    expectedFolder(input.use) !== location.folderPath ||
    bindingFolder(input.binding) !== location.folderPath
  ) {
    return blocked("binding-mismatch", "The saved Binding does not resolve to this exact source and project location.");
  }
  if (input.base.baseRevisionId !== input.use.baseRevisionId || input.base.revision.algorithm !== "omni-tree-v1")
    return needsInput("base-integrity", "The saved immutable base does not match this managed use.");

  const evidence: SkillDetachmentEvidence = {
    choice: "detach-managed",
    skillId: input.request.skillId,
    storeRevision: input.storeRevision,
    record: input.record,
    local: input.local,
    use: input.use,
    binding: input.binding,
    base: input.base,
  };
  const scope: SkillScope = {
    sourceId: input.use.source.sourceId,
    packageId: input.use.source.packageId,
    artifactPath: input.use.source.artifactPath,
    targets: [{ projectId: location.projectId, harnessId: location.harnessId, bindingId: input.binding.bindingId }],
  };
  const bindingEffects: readonly SkillBindingEffect[] = [{ bindingId: input.binding.bindingId, before: input.binding }];
  const metadataEffects: readonly SkillUseEffect[] = [{ skillId: input.request.skillId, location, before: input.use }];
  const fingerprint: SkillEffectFingerprint = {
    scope,
    files: [],
    bindings: bindingEffects,
    actions: [],
    metadataEffects,
    detachmentEvidence: evidence,
  };
  return {
    status: "ready",
    stepId: childStepId(input.intentId, location),
    evidence,
    scope,
    files: [],
    actions: [],
    bindingEffects,
    metadataEffects,
    fingerprint,
  };
}
