import { readSourceSkillObservation } from "./source-observation";
import { activeWorkshop, activeStorefronts, StorefrontTargetError } from "../../domain/source-roles";
import { createHash } from "node:crypto";

import { planSkillPropagationTarget } from "../../domain/skill-reconciliation/propagation";
import { createSkillRevision } from "../../domain/skill-reconciliation/revisions";
import type {
  ManagedSkillUse,
  SkillLocationKey,
  SkillRevision,
  SkillRelationshipsState,
  SkillUseEffect,
} from "../../domain/skill-reconciliation/types";
import { writeSkillFileBytes } from "../../shared/operations-write-skill-ipc";
import type { SkillPropagationIntent, SkillPropagationTarget } from "../../shared/skill-propagation-ipc";
import type { Binding } from "../../domain/assignment-plan";
import type { SkillObservationFilesystem } from "../../ports/skill-reconciliation";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import type { SkillBaseStore } from "../skill-reconciliation/bases";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import {
  hasCompleteObservationForLocation,
  observationIssueForLocation,
} from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import { captureSkillTree, revalidateSkillTree, type SkillTreeCapture } from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import { sourceMatches, validateTargetRelationship } from "./propagation-relationship";
import { summarizePropagationFiles } from "./propagation-tree-planning";
import {
  freshGrant,
  hasActiveSourceAndProject,
  observationGrant,
  observedLocalTarget,
  observedSourcePath,
  skillRootIdentity,
  SKILL_SCAN_BUDGET_BYTES,
} from "./adoption-reader";

type CompleteTree = Extract<SkillTreeCapture, { status: "complete" }>;
type Tree = Readonly<{ revision: SkillRevision; files: ReadonlyMap<string, Uint8Array> }>;
export type SkillPropagationLocationSnapshot = Readonly<{
  location: SkillLocationKey;
  projectGrant?: RegistryGrant;
  localTree?: CompleteTree;
  use?: ManagedSkillUse;
  binding?: Binding;
  baseRevisionId?: string;
  baseTree?: Tree;
  rootIdentity?: string;
  target: SkillPropagationTarget;
  useEffect?: SkillUseEffect;
  nextBinding?: Binding;
}>;

export type SkillPropagationSnapshot =
  | Readonly<{ status: "blocked"; code: string; message: string }>
  | Readonly<{
      status: "ready";
      intent: SkillPropagationIntent;
      sourceGrant: RegistryGrant;
      sourceFolderPath: string;
      sourceTree: CompleteTree;
      projectedSource: Tree;
      sourceRootIdentity: string;
      relationshipRevision: number;
      relationships: SkillRelationshipsState;
      bindings: readonly Binding[];
      locations: readonly SkillPropagationLocationSnapshot[];
    }>;

export type SkillPropagationReaderDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  bases: SkillBaseStore;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
}>;

function blocked(code: string, message: string): SkillPropagationSnapshot {
  return { status: "blocked", code, message };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function baseReferenceKey(location: SkillLocationKey): string {
  return `${location.projectId}\n${location.harnessId}\n${location.folderPath}`;
}

function stableUuid(seed: string): string {
  const digits = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32).split("");
  digits[12] = "5";
  digits[16] = ((Number.parseInt(digits[16]!, 16) & 3) | 8).toString(16);
  const hex = digits.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hasActiveOwnedSource(
  response: Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>,
  sourceId: string,
): boolean {
  const source = response.status === "ready" ? activeWorkshop(response.registry) : undefined;
  return source?.ref.id === sourceId && source.availability === "available";
}

function projectSourceTree(source: CompleteTree, intent: SkillPropagationIntent): Tree {
  if (intent.kind !== "update-and-maintain") return { revision: source.revision, files: source.files };
  const files = new Map(source.files);
  if (intent.request.replaceFolder) files.clear();
  for (const file of intent.request.files) {
    const bytes = writeSkillFileBytes(file);
    files.set(file.path, bytes);
  }
  const byteLength = [...files.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
  if (files.size > 512 || byteLength > SKILL_SCAN_BUDGET_BYTES)
    throw new Error("The projected complete source tree exceeds the observation limit.");
  const revisions = [...files.entries()].map(([path, bytes]) => ({
    path,
    hash: sha256(bytes),
    byteLength: bytes.byteLength,
  }));
  return { revision: createSkillRevision(revisions, sha256), files };
}

async function captureTree(
  grant: RegistryGrant,
  folderPath: string,
  filesystem: SkillObservationFilesystem,
): Promise<SkillTreeCapture> {
  return captureSkillTree(
    observationGrant(grant),
    folderPath,
    { remainingBytes: SKILL_SCAN_BUDGET_BYTES },
    filesystem,
    sha256,
  );
}

export async function readSkillPropagationSnapshot(
  intent: SkillPropagationIntent,
  dependencies: SkillPropagationReaderDependencies,
): Promise<SkillPropagationSnapshot> {
  const now = dependencies.now ?? Date.now;
  const filesystem = dependencies.filesystem ?? strictSkillObservationFilesystem;
  const registryBefore = await dependencies.registry.listRegistry();
  if (
    registryBefore.status === "ready" &&
    activeStorefronts(registryBefore.registry).some((source) => source.ref.id === intent.source.sourceId)
  ) {
    const error = new StorefrontTargetError();
    return blocked(error.code, error.message);
  }
  if (registryBefore.status !== "ready")
    return blocked("registry-unavailable", "Reopen the source and selected projects, then refresh the operation.");
  if (!hasActiveOwnedSource(registryBefore, intent.source.sourceId))
    return blocked("source-unavailable", "The owned source is inactive or unavailable.");
  const sourceGrant = await freshGrant(dependencies.registry, { kind: "source", id: intent.source.sourceId }, now);
  if (!sourceGrant || !(await currentGrantRoot(sourceGrant)))
    return blocked("source-grant-unavailable", "Fresh access to the owned source is required.");
  const sourceObservation = await dependencies.registry.observeEntryWithGrant(
    { kind: "source", id: intent.source.sourceId },
    sourceGrant.handle,
  );
  if (sourceObservation.status !== "observed")
    return blocked("source-observation-incomplete", "The owned source could not be observed completely.");
  const sourceRead = readSourceSkillObservation(sourceObservation, intent.source, observedSourcePath);
  if (sourceRead.status === "blocked") return sourceRead;
  const sourceFolderPath = sourceRead.folderPath;
  const sourceTree = await captureTree(sourceGrant, sourceFolderPath, filesystem);
  if (sourceTree.status !== "complete")
    return blocked("source-tree-incomplete", "The complete owned skill tree could not be read safely.");
  let projectedSource: Tree;
  try {
    projectedSource = projectSourceTree(sourceTree, intent);
  } catch {
    return blocked("source-projection-invalid", "The complete source tree would exceed its safe observation limit.");
  }
  const [relationshipRead, bindingRead] = await Promise.all([
    dependencies.relationships.read(),
    dependencies.bindings.read(),
  ]);
  if (relationshipRead.status !== "ready" || bindingRead.status !== "ready")
    return blocked(
      "management-store-unavailable",
      "Skill relationships and Bindings must be readable before maintenance.",
    );
  const sourceUses = relationshipRead.state.uses.filter(
    (use) => !use.disabled && sourceMatches(use.source, intent.source),
  );
  const selectedLocations = intent.locations ?? [
    ...new Map(sourceUses.map((use) => [locationKey(use.location), use.location])).values(),
  ];
  const enabledLocations = selectedLocations.filter(
    (location) =>
      !relationshipRead.state.uses.some((use) => use.disabled && locationKey(use.location) === locationKey(location)),
  );
  if (selectedLocations.length > 64)
    return blocked(
      "scope-too-large",
      "This source has more than 64 managed uses. Narrow the project locations and refresh the preview.",
    );
  const grants = new Map<string, RegistryGrant | undefined>();
  const snapshots: SkillPropagationLocationSnapshot[] = [];
  for (const location of enabledLocations) {
    const knownUse = sourceUses.find((use) => locationKey(use.location) === locationKey(location));
    if (!hasActiveSourceAndProject(registryBefore, intent.source.sourceId, location.projectId)) {
      snapshots.push({
        location,
        target: {
          location,
          ...(knownUse ? { skillId: knownUse.skillId } : {}),
          state: "unavailable",
          reason: "The selected project is inactive or unavailable.",
        },
      });
      continue;
    }
    let projectGrant = grants.get(location.projectId);
    if (!grants.has(location.projectId)) {
      projectGrant = await freshGrant(dependencies.registry, { kind: "project", id: location.projectId }, now);
      grants.set(location.projectId, projectGrant);
    }
    if (!projectGrant || !(await currentGrantRoot(projectGrant))) {
      snapshots.push({
        location,
        target: {
          location,
          ...(knownUse ? { skillId: knownUse.skillId } : {}),
          state: "unavailable",
          reason: "The project is inaccessible or its granted root changed.",
        },
      });
      continue;
    }
    const projectObservation = await dependencies.registry.observeEntryWithGrant(
      { kind: "project", id: location.projectId },
      projectGrant.handle,
    );
    const observationIssue =
      projectObservation.status === "observed"
        ? observationIssueForLocation(projectObservation.observation.inventory, location.folderPath)
        : undefined;
    if (
      !hasCompleteObservationForLocation(projectObservation, location.folderPath) ||
      !observedLocalTarget(projectObservation.observation.inventory, location)
    ) {
      snapshots.push({
        location,
        projectGrant,
        target: {
          location,
          ...(knownUse ? { skillId: knownUse.skillId } : {}),
          state: "unavailable",
          reason: observationIssue
            ? `The target observation is incomplete at ${observationIssue.location} (${observationIssue.code}): ${observationIssue.message}`
            : "The exact conventional project skill folder is missing, unsafe or ambiguous.",
        },
      });
      continue;
    }
    const relationship = validateTargetRelationship(
      intent.source,
      location,
      knownUse?.skillId,
      relationshipRead.state.uses,
      bindingRead.bindings,
      relationshipRead.state.skills,
      sourceObservation.observation.inventory,
    );
    const localTree = await captureTree(projectGrant, location.folderPath, filesystem);
    if (localTree.status !== "complete") {
      snapshots.push({
        location,
        projectGrant,
        target: {
          location,
          ...(knownUse ? { skillId: knownUse.skillId } : {}),
          state: "unavailable",
          reason: "The complete local tree could not be read safely.",
        },
      });
      continue;
    }
    const base = relationship.use
      ? await dependencies.bases.read(relationship.use.baseRevisionId)
      : { status: "missing" as const };
    if (
      relationship.reason ||
      !relationship.use ||
      !relationship.binding ||
      relationship.use.baseUnavailable ||
      base.status !== "ready"
    ) {
      snapshots.push({
        location,
        projectGrant,
        localTree,
        ...(relationship.use ? { use: relationship.use } : {}),
        ...(relationship.binding ? { binding: relationship.binding } : {}),
        target: {
          location,
          ...(relationship.use ? { skillId: relationship.use.skillId } : knownUse ? { skillId: knownUse.skillId } : {}),
          ...(projectGrant ? { projectRootIdentity: skillRootIdentity(projectGrant, sha256) } : {}),
          ...(relationship.use
            ? { bindingId: relationship.use.bindingId, baseRevisionId: relationship.use.baseRevisionId }
            : {}),
          state: !relationship.reason && relationship.use?.baseUnavailable ? "retained-local" : "withheld",
          reason:
            relationship.reason ??
            (relationship.use?.baseUnavailable
              ? "The legacy copy has no complete ownership evidence; its local content is retained."
              : base.status === "corrupt"
                ? "The immutable base is corrupt."
                : "The immutable base is unavailable or the location is unlinked."),
          sourceRevision: projectedSource.revision,
          localRevision: localTree.revision,
        },
      });
      continue;
    }
    const state = planSkillPropagationTarget({
      source: projectedSource.revision,
      local: localTree.revision,
      base: base.revision,
      managed: true,
      safe: true,
    });
    const targetSkillId = relationship.use.skillId;
    const nextBaseId = stableUuid(`${targetSkillId}\n${baseReferenceKey(location)}\n${projectedSource.revision.hash}`);
    const nextBinding =
      state === "eligible" || state === "already-current"
        ? {
            ...relationship.binding,
            boundHash:
              projectedSource.revision.files.find((file) => file.path === "SKILL.md")?.hash ??
              relationship.binding.boundHash,
            ownedHash:
              projectedSource.revision.files.find((file) => file.path === "SKILL.md")?.hash ??
              relationship.binding.ownedHash,
          }
        : relationship.binding;
    const useEffect =
      state === "eligible" || state === "already-current"
        ? {
            skillId: targetSkillId,
            location,
            before: relationship.use,
            after: { ...relationship.use, baseRevisionId: nextBaseId },
          }
        : undefined;
    snapshots.push({
      location,
      projectGrant,
      localTree,
      use: relationship.use,
      binding: relationship.binding,
      baseRevisionId: relationship.use.baseRevisionId,
      baseTree: { revision: base.revision, files: base.files },
      rootIdentity: skillRootIdentity(projectGrant, sha256),
      target: {
        location,
        skillId: targetSkillId,
        projectRootIdentity: skillRootIdentity(projectGrant, sha256),
        bindingId: relationship.use.bindingId,
        baseRevisionId: relationship.use.baseRevisionId,
        state,
        sourceRevision: projectedSource.revision,
        localRevision: localTree.revision,
        baseRevision: base.revision,
        files: summarizePropagationFiles(projectedSource, { revision: localTree.revision, files: localTree.files }),
      },
      ...(useEffect ? { useEffect } : {}),
      ...(nextBinding !== relationship.binding ? { nextBinding } : {}),
    });
  }
  const locations = snapshots.map((snapshot) => snapshot.location);
  const projectIds = [...new Set(locations.map((location) => location.projectId))];
  const grantsStillValid = await Promise.all(
    projectIds.map(async (projectId) => {
      const grant = grants.get(projectId);
      return Boolean(!grant || (grant.expiresAt > now() && (await currentGrantRoot(grant))));
    }),
  );
  const [relationshipsAfter, bindingsAfter, sourceAfter, registryAfter] = await Promise.all([
    dependencies.relationships.read(),
    dependencies.bindings.read(),
    revalidateSkillTree(sourceTree, observationGrant(sourceGrant), filesystem),
    dependencies.registry.listRegistry(),
  ]);
  const targetsStillValid = await Promise.all(
    snapshots.map(async (snapshot) =>
      snapshot.localTree && snapshot.projectGrant
        ? (await revalidateSkillTree(snapshot.localTree, observationGrant(snapshot.projectGrant), filesystem))
            .status === "complete"
        : true,
    ),
  );
  if (
    relationshipsAfter.status !== "ready" ||
    relationshipsAfter.state.revision !== relationshipRead.state.revision ||
    bindingsAfter.status !== "ready" ||
    !same(bindingsAfter.bindings, bindingRead.bindings) ||
    sourceAfter.status !== "complete" ||
    sourceAfter.revision.hash !== sourceTree.revision.hash ||
    registryAfter.status !== "ready" ||
    !hasActiveOwnedSource(registryAfter, intent.source.sourceId) ||
    !snapshots.every(
      ({ location, projectGrant }) =>
        !projectGrant || hasActiveSourceAndProject(registryAfter, intent.source.sourceId, location.projectId),
    ) ||
    !grantsStillValid.every(Boolean) ||
    !targetsStillValid.every(Boolean) ||
    sourceGrant.expiresAt <= now()
  )
    return blocked(
      "evidence-changed",
      "A root, source tree, project tree, Binding or relationship changed during preview.",
    );
  return {
    status: "ready",
    intent,
    sourceGrant,
    sourceFolderPath,
    sourceTree,
    projectedSource,
    sourceRootIdentity: skillRootIdentity(sourceGrant, sha256),
    relationshipRevision: relationshipRead.state.revision,
    relationships: relationshipRead.state,
    bindings: bindingRead.bindings,
    locations: snapshots,
  };
}

export function propagationTargetKey(location: SkillLocationKey): string {
  return baseReferenceKey(location);
}

export function propagationEvidenceFingerprint(
  snapshot: Extract<SkillPropagationSnapshot, { status: "ready" }>,
): string {
  return sha256(
    JSON.stringify({
      sourceRef: snapshot.intent.source,
      sourceRoot: snapshot.sourceRootIdentity,
      sourceRevision: snapshot.projectedSource.revision,
      relationshipRevision: snapshot.relationshipRevision,
      targets: snapshot.locations.map(({ target, rootIdentity, use, binding }) => ({
        target,
        rootIdentity,
        use,
        binding,
      })),
    }),
  );
}
