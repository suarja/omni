import { createHash } from "node:crypto";

import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
} from "../../domain/skill-reconciliation/types";
import type { SkillDetachmentRequest } from "../../shared/skill-detachment-request";
import type { SkillDirectoryEnvelope } from "../../shared/skill-directory-envelope";
import type { SkillObservationFilesystem, SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { BindingsStore } from "../bindings-store";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import { hasCompleteObservationForLocation } from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import {
  captureComplete,
  freshGrant,
  observedLocalTarget,
  observationGrant,
  SKILL_SCAN_BUDGET_BYTES,
  skillRootIdentity,
} from "./adoption-reader";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import { readSkillDetachmentEnvelope } from "./detachment-envelope";

type CompleteTree = NonNullable<Awaited<ReturnType<typeof captureComplete>>>;
type ReadyTree = Extract<CompleteTree, { status: "complete" }>;
type BaseEvidence = Readonly<{ baseRevisionId: string; revision: SkillRevision }>;

export type SkillDetachmentSnapshot =
  | Readonly<{ status: "blocked" | "needs-input"; code: string; message: string }>
  | Readonly<{
      status: "ready";
      request: SkillDetachmentRequest;
      projectGrant: RegistryGrant;
      localTree: ReadyTree;
      rootIdentity: string;
      envelope: SkillDirectoryEnvelope;
      relationships: Extract<Awaited<ReturnType<SkillRelationshipStore["read"]>>, { status: "ready" }>["state"];
      bindings: readonly import("../../domain/assignment-plan").Binding[];
      record: LogicalSkillRecord | undefined;
      use: ManagedSkillUse | undefined;
      binding: import("../../domain/assignment-plan").Binding | undefined;
      base: BaseEvidence | undefined;
    }>;

export type SkillDetachmentReaderDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  bases: SkillBaseStore;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
  digest?: (value: string) => string;
}>;

function blocked(code: string, message: string): SkillDetachmentSnapshot {
  return { status: "blocked", code, message };
}

function needsInput(code: string, message: string): SkillDetachmentSnapshot {
  return { status: "needs-input", code, message };
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function activeProject(registry: Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>, projectId: string): boolean {
  if (registry.status !== "ready") return false;
  const project = registry.registry.projects.find(({ ref }) => ref.id === projectId);
  return project?.availability === "available" && project.archivedAt === undefined;
}

async function projectObservationIsComplete(
  registry: RegistryIpcServices,
  grant: RegistryGrant,
  request: SkillDetachmentRequest,
): Promise<boolean> {
  const observed = await registry.observeEntryWithGrant(
    { kind: "project", id: request.locations[0]!.projectId },
    grant.handle,
  );
  return (
    hasCompleteObservationForLocation(observed, request.locations[0]!.folderPath) &&
    observedLocalTarget(observed.observation.inventory, request.locations[0]!)
  );
}

export async function readSkillDetachmentSnapshot(
  request: SkillDetachmentRequest,
  dependencies: SkillDetachmentReaderDependencies,
): Promise<SkillDetachmentSnapshot> {
  const now = dependencies.now ?? Date.now;
  const filesystem = dependencies.filesystem ?? strictSkillObservationFilesystem;
  const digest = dependencies.digest ?? ((value) => createHash("sha256").update(value, "utf8").digest("hex"));
  const location = request.locations[0];
  if (!location || request.locations.length !== 1)
    return blocked("selection-invalid", "Stop management requires one exact project location.");

  const registryBefore = await dependencies.registry.listRegistry();
  if (!activeProject(registryBefore, location.projectId))
    return blocked("project-unavailable", "Reopen the active project before stopping management.");
  const projectGrant = await freshGrant(dependencies.registry, { kind: "project", id: location.projectId }, now);
  if (!projectGrant || !(await currentGrantRoot(projectGrant)))
    return blocked("root-changed", "The registered project root changed; reopen it and refresh the preview.");
  if (!(await projectObservationIsComplete(dependencies.registry, projectGrant, request)))
    return blocked("target-child-ambiguous", "The exact conventional project child is missing, aliased, or ambiguous.");

  const [relationshipRead, bindingRead] = await Promise.all([
    dependencies.relationships.read(),
    dependencies.bindings.read(),
  ]);
  if (relationshipRead.status !== "ready")
    return blocked("relationship-store-unavailable", "Skill relationship metadata is unavailable or corrupt.");
  if (bindingRead.status !== "ready")
    return blocked("binding-store-unavailable", "The Binding store is unavailable or corrupt.");

  const localTree = await captureComplete(
    projectGrant,
    location.folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    filesystem,
    digest,
  );
  if (!localTree)
    return blocked(
      "target-tree-incomplete",
      "The selected project tree is unsafe, changing, or exceeds the read limits.",
    );
  const grant = observationGrant(projectGrant);
  let envelope: SkillDirectoryEnvelope;
  try {
    const observedEnvelope = await readSkillDetachmentEnvelope(grant, location.folderPath, filesystem);
    if (!observedEnvelope)
      return blocked("target-envelope-unavailable", "The selected project tree envelope is unavailable.");
    envelope = observedEnvelope;
  } catch {
    return blocked("target-envelope-unavailable", "The selected project tree envelope could not be verified safely.");
  }

  const record = relationshipRead.state.skills.find((item) => item.skillId === request.skillId);
  const locationUses = relationshipRead.state.uses.filter((use) => locationKey(use.location) === locationKey(location));
  const selectedUses = locationUses.filter((use) => use.skillId === request.skillId);
  const use = locationUses.length === 1 && selectedUses.length === 1 ? selectedUses[0] : undefined;
  const selectedBindings = use ? bindingRead.bindings.filter((item) => item.bindingId === use.bindingId) : [];
  const binding = selectedBindings.length === 1 ? selectedBindings[0] : undefined;
  let base: BaseEvidence | undefined;
  if (use) {
    const savedBase = await dependencies.bases.read(use.baseRevisionId);
    if (savedBase.status === "ready" && savedBase.baseRevisionId === use.baseRevisionId) {
      base = { baseRevisionId: savedBase.baseRevisionId, revision: savedBase.revision };
    }
  }

  const afterTree = await captureComplete(
    projectGrant,
    location.folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    filesystem,
    digest,
  );
  let envelopeAfter: SkillDirectoryEnvelope | undefined;
  try {
    envelopeAfter = await readSkillDetachmentEnvelope(grant, location.folderPath, filesystem);
  } catch {
    return blocked("target-tree-changed", "The selected project directory changed during the read.");
  }
  const [relationshipAfter, bindingAfter, registryAfter] = await Promise.all([
    dependencies.relationships.read(),
    dependencies.bindings.read(),
    dependencies.registry.listRegistry(),
  ]);
  if (
    !afterTree ||
    !same(localTree.revision, afterTree.revision) ||
    !same(envelope, envelopeAfter) ||
    !(await currentGrantRoot(projectGrant)) ||
    projectGrant.expiresAt <= now()
  ) {
    return blocked("target-tree-changed", "The selected project root or directory changed during the read.");
  }
  if (
    relationshipAfter.status !== "ready" ||
    relationshipAfter.state.revision !== relationshipRead.state.revision ||
    !same(relationshipAfter.state, relationshipRead.state)
  ) {
    return blocked(
      "relationship-store-changed",
      "Skill relationship metadata changed during the read; refresh the preview.",
    );
  }
  if (bindingAfter.status !== "ready" || !same(bindingAfter.bindings, bindingRead.bindings))
    return blocked("binding-store-changed", "Bindings changed during the read; refresh the preview.");
  if (
    !activeProject(registryAfter, location.projectId) ||
    !(await projectObservationIsComplete(dependencies.registry, projectGrant, request))
  ) {
    return blocked("project-observation-changed", "The active project observation changed during the read.");
  }
  if (use && base) {
    const baseAfter = await dependencies.bases.read(base.baseRevisionId);
    if (baseAfter.status !== "ready" || !same(baseAfter.revision, base.revision))
      return needsInput("base-integrity", "The immutable base changed or failed verification during the read.");
  } else if (use) {
    return needsInput("base-unavailable", "The immutable base is missing or corrupt; stop management is withheld.");
  }

  return {
    status: "ready",
    request,
    projectGrant,
    localTree: localTree as ReadyTree,
    rootIdentity: skillRootIdentity(projectGrant, digest),
    envelope,
    relationships: relationshipRead.state,
    bindings: bindingRead.bindings,
    record,
    use,
    binding,
    base,
  };
}
