import { readSourceSkillObservation, type SourceObservationBlock } from "./source-observation";
import { activeWorkshop, activeStorefronts, StorefrontTargetError } from "../../domain/source-roles";
import { createHash } from "node:crypto";

import type {
  LogicalSkillRecord,
  ManagedSkillUse,
  SkillLocationKey,
  SkillRelationshipsState,
  SourceSkillRef,
} from "../../domain/skill-reconciliation/types";
import type { SkillManagedResolutionRequest } from "../../shared/skill-reconciliation-request";
import type { SkillObservationFilesystem, SkillObservationGrant } from "../../ports/skill-reconciliation";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import type { SkillBaseRead, SkillBaseStore } from "../skill-reconciliation/bases";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import { hasCompleteObservationForLocation } from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import {
  revalidateSkillTree,
  type SkillScanBudget,
  type SkillTreeCapture,
} from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";
import {
  captureComplete,
  freshGrant,
  observedLocalTarget,
  observedSourcePath,
  observationGrant,
  skillRootIdentity,
  SKILL_SCAN_BUDGET_BYTES,
} from "./adoption-reader";

type CompleteTree = Extract<SkillTreeCapture, { status: "complete" }>;
type ReadyBase = Extract<SkillBaseRead, { status: "ready" }>;
type SourceMode = "required" | "optional" | "skip";

export type SkillResolutionSnapshot =
  | Readonly<{
      status: "ready";
      projectGrant: RegistryGrant;
      projectObservationGrant: SkillObservationGrant;
      sourceGrant?: RegistryGrant;
      sourceObservationGrant?: SkillObservationGrant;
      localTree: CompleteTree;
      sourceTree?: CompleteTree;
      rootIdentities: Readonly<{ project: string; source?: string }>;
      relationships: SkillRelationshipsState;
      record: LogicalSkillRecord;
      use: ManagedSkillUse;
      binding: import("../../domain/assignment-plan").Binding;
      base: ReadyBase;
    }>
  | Readonly<{ status: "blocked" | "needs-input"; code: string; message: string }>;

export type SkillResolutionReaderDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  bases: SkillBaseStore;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
  digest?: (value: string) => string;
}>;

function locationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

function sourceKey(source: SourceSkillRef): string {
  return JSON.stringify([source.sourceId, source.packageId, source.artifactPath]);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

function activeProject(registry: Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>, projectId: string): boolean {
  return (
    registry.status === "ready" &&
    registry.registry.projects.some(
      ({ ref, availability, archivedAt }) =>
        ref.id === projectId && availability === "available" && archivedAt === undefined,
    )
  );
}

function bindingForLocation(bindings: readonly import("../../domain/assignment-plan").Binding[], use: ManagedSkillUse) {
  const matches = bindings.filter(({ bindingId }) => bindingId === use.bindingId);
  return matches.length === 1 ? matches[0] : undefined;
}

function sourceIsActive(registry: Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>, sourceId: string): boolean {
  return (
    registry.status === "ready" &&
    activeWorkshop(registry.registry)?.ref.id === sourceId &&
    activeWorkshop(registry.registry)?.availability === "available"
  );
}

async function captureSource(
  dependencies: SkillResolutionReaderDependencies,
  source: SourceSkillRef,
  registry: Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>,
  budget: SkillScanBudget,
  filesystem: SkillObservationFilesystem,
  digest: (value: string) => string,
  now: () => number,
): Promise<
  Readonly<{ status: "ready"; grant: RegistryGrant; tree: CompleteTree }> | SourceObservationBlock | undefined
> {
  if (!sourceIsActive(registry, source.sourceId)) return undefined;
  const grant = await freshGrant(dependencies.registry, { kind: "source", id: source.sourceId }, now);
  if (!grant || !(await currentGrantRoot(grant))) return undefined;
  const observed = await dependencies.registry.observeEntryWithGrant(
    { kind: "source", id: source.sourceId },
    grant.handle,
  );
  const sourceRead = readSourceSkillObservation(observed, source, observedSourcePath);
  if (sourceRead.status === "blocked") return sourceRead;
  const folder = sourceRead.folderPath;
  const tree = await captureComplete(grant, folder, budget, filesystem, digest);
  if (!tree || (await revalidateSkillTree(tree, observationGrant(grant), filesystem)).status !== "complete")
    return undefined;
  const observedAfter = await dependencies.registry.observeEntryWithGrant(
    { kind: "source", id: source.sourceId },
    grant.handle,
  );
  const sourceAfter = readSourceSkillObservation(observedAfter, source, observedSourcePath);
  if (sourceAfter.status === "blocked") return sourceAfter;
  if (sourceAfter.folderPath !== folder || !(await currentGrantRoot(grant)) || grant.expiresAt <= now())
    return undefined;
  return { status: "ready", grant, tree };
}

export async function readSkillResolutionSnapshot(
  request: SkillManagedResolutionRequest,
  dependencies: SkillResolutionReaderDependencies,
  sourceMode: SourceMode = request.choice === "use-canonical" ? "required" : "optional",
): Promise<SkillResolutionSnapshot> {
  const now = dependencies.now ?? Date.now;
  const filesystem = dependencies.filesystem ?? strictSkillObservationFilesystem;
  const digest = dependencies.digest ?? ((value: string) => createHash("sha256").update(value, "utf8").digest("hex"));
  const [location] = request.locations;
  const registryBefore = await dependencies.registry.listRegistry();
  if (!activeProject(registryBefore, location.projectId)) {
    return {
      status: "blocked",
      code: "project-unavailable",
      message: "Reopen the active project before resolving its managed copy.",
    };
  }
  const projectGrant = await freshGrant(dependencies.registry, { kind: "project", id: location.projectId }, now);
  if (!projectGrant || !(await currentGrantRoot(projectGrant))) {
    return {
      status: "blocked",
      code: "project-grant-unavailable",
      message: "Fresh access to the selected project is required.",
    };
  }
  const [relationshipRead, bindingRead] = await Promise.all([
    dependencies.relationships.read(),
    dependencies.bindings.read(),
  ]);
  if (relationshipRead.status !== "ready")
    return {
      status: "blocked",
      code: "relationship-store-unavailable",
      message: "Skill relationships are unavailable or corrupt.",
    };
  if (bindingRead.status !== "ready")
    return {
      status: "blocked",
      code: "binding-store-unavailable",
      message: "The current Binding store is unavailable or corrupt.",
    };
  const record = relationshipRead.state.skills.find((item) => item.skillId === request.skillId);
  if (!record || !record.locations.some((candidate) => locationKey(candidate) === locationKey(location))) {
    return {
      status: "blocked",
      code: "location-not-in-skill",
      message: "The selected location no longer belongs to this logical skill.",
    };
  }
  const uses = relationshipRead.state.uses.filter(
    (candidate) => locationKey(candidate.location) === locationKey(location),
  );
  const use = uses.length === 1 && uses[0]?.skillId === request.skillId ? uses[0] : undefined;
  if (!use)
    return {
      status: "blocked",
      code: "managed-use-unavailable",
      message: "The selected location has no exact managed skill use.",
    };
  if (
    registryBefore.status === "ready" &&
    activeStorefronts(registryBefore.registry).some((source) => source.ref.id === use.source.sourceId)
  ) {
    const error = new StorefrontTargetError();
    return { status: "blocked", code: error.code, message: error.message };
  }
  const binding = bindingForLocation(bindingRead.bindings, use);
  if (!binding)
    return {
      status: "blocked",
      code: "binding-unavailable",
      message: "The managed use does not resolve to exactly one current Binding.",
    };
  const base = await dependencies.bases.read(use.baseRevisionId);
  if (base.status !== "ready") {
    return {
      status: "needs-input",
      code: "base-unavailable",
      message: "The immutable base is missing or corrupt; inspect managed recovery before resolving this copy.",
    };
  }

  const projectObservation = await dependencies.registry.observeEntryWithGrant(
    { kind: "project", id: location.projectId },
    projectGrant.handle,
  );
  if (
    !hasCompleteObservationForLocation(projectObservation, location.folderPath) ||
    !observedLocalTarget(projectObservation.observation.inventory, location)
  ) {
    return {
      status: "blocked",
      code: "target-child-unavailable",
      message: "The exact conventional project skill child is missing, aliased, provider-managed, or ambiguous.",
    };
  }
  const budget: SkillScanBudget = { remainingBytes: SKILL_SCAN_BUDGET_BYTES };
  const localTree = await captureComplete(projectGrant, location.folderPath, budget, filesystem, digest);
  if (!localTree)
    return {
      status: "blocked",
      code: "local-tree-unavailable",
      message: "The selected project tree is unsafe, incomplete, or exceeds the observation limits.",
    };

  let source: Readonly<{ grant: RegistryGrant; tree: CompleteTree }> | undefined;
  if (sourceMode !== "skip") {
    const captured = await captureSource(dependencies, use.source, registryBefore, budget, filesystem, digest, now);
    if (captured?.status === "blocked" && sourceMode === "required") return captured;
    if (captured?.status === "ready") source = captured;
  }
  if (sourceMode === "required" && !source) {
    return {
      status: "needs-input",
      code: "source-unavailable",
      message: "The approved owned source is unavailable for a complete canonical review.",
    };
  }
  if ((await revalidateSkillTree(localTree, observationGrant(projectGrant), filesystem)).status !== "complete") {
    return {
      status: "blocked",
      code: "local-tree-changed",
      message: "The selected project tree changed during its complete read.",
    };
  }
  if (!(await currentGrantRoot(projectGrant)) || projectGrant.expiresAt <= now()) {
    return {
      status: "blocked",
      code: "project-root-changed",
      message: "The registered project root changed during review.",
    };
  }
  const [relationshipAfter, bindingAfter, baseAfter, registryAfter] = await Promise.all([
    dependencies.relationships.read(),
    dependencies.bindings.read(),
    dependencies.bases.read(use.baseRevisionId),
    dependencies.registry.listRegistry(),
  ]);
  if (
    relationshipAfter.status !== "ready" ||
    canonical(relationshipAfter.state) !== canonical(relationshipRead.state)
  ) {
    return {
      status: "blocked",
      code: "relationship-store-changed",
      message: "Managed skill relationships changed during review; refresh it.",
    };
  }
  if (bindingAfter.status !== "ready" || canonical(bindingAfter.bindings) !== canonical(bindingRead.bindings)) {
    return { status: "blocked", code: "binding-store-changed", message: "Bindings changed during review; refresh it." };
  }
  if (baseAfter.status !== "ready" || canonical(baseAfter.revision) !== canonical(base.revision)) {
    return {
      status: "needs-input",
      code: "base-changed",
      message: "The verified immutable base changed during review.",
    };
  }
  if (!activeProject(registryAfter, location.projectId) || !(await currentGrantRoot(projectGrant))) {
    return {
      status: "blocked",
      code: "project-root-changed",
      message: "The project registration changed during review.",
    };
  }
  if (
    source &&
    (!sourceIsActive(registryAfter, use.source.sourceId) ||
      source.grant.expiresAt <= now() ||
      !(await currentGrantRoot(source.grant)))
  ) {
    if (sourceMode === "required")
      return {
        status: "needs-input",
        code: "source-root-changed",
        message: "The approved source changed during review; refresh it.",
      };
    source = undefined;
  }
  return {
    status: "ready",
    projectGrant,
    projectObservationGrant: observationGrant(projectGrant),
    ...(source
      ? { sourceGrant: source.grant, sourceObservationGrant: observationGrant(source.grant), sourceTree: source.tree }
      : {}),
    localTree,
    rootIdentities: {
      project: skillRootIdentity(projectGrant, digest),
      ...(source ? { source: skillRootIdentity(source.grant, digest) } : {}),
    },
    relationships: relationshipRead.state,
    record,
    use,
    binding,
    base,
  };
}
