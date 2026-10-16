import { resolveObservedPackage } from "../../domain/observed-package-resolution";
import { readSourceSkillObservation } from "./source-observation";
import { activeStorefronts, StorefrontTargetError } from "../../domain/source-roles";
import { activeWorkshop } from "../../domain/source-roles";
import { createHash } from "node:crypto";

import type {
  SkillLocationKey,
  SkillRelationshipsState,
  SourceSkillRef,
} from "../../domain/skill-reconciliation/types";
import type { SkillAdoptionRequest } from "../../shared/skill-reconciliation-request";
import type { SkillObservationFilesystem, SkillObservationGrant } from "../../ports/skill-reconciliation";
import type { SkillRelationshipStore } from "../../ports/skill-reconciliation";
import type { RegistryGrant, RegistryIpcServices } from "../registry-ipc";
import type { BindingsStore } from "../bindings-store";
import { hasCompleteObservationForLocation } from "../skill-reconciliation/location-observation";
import { currentGrantRoot } from "../granted-hashing";
import {
  captureSkillTree,
  revalidateSkillTree,
  type SkillScanBudget,
  type SkillTreeCapture,
} from "../skill-reconciliation/capture-engine";
import { strictSkillObservationFilesystem } from "../skill-reconciliation/filesystem";

export const SKILL_SCAN_BUDGET_BYTES = 32 * 1024 * 1024;
export type ObservedSkillEntryResponse = Extract<
  Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>,
  { status: "observed" }
>;

export type SkillAdoptionSnapshot =
  | Readonly<{
      status: "ready";
      sourceGrant: RegistryGrant;
      projectGrant: RegistryGrant;
      sourceTree: Extract<SkillTreeCapture, { status: "complete" }>;
      localTrees: readonly Readonly<{
        location: SkillLocationKey;
        grant: SkillObservationGrant;
        tree: Extract<SkillTreeCapture, { status: "complete" }>;
      }>[];
      relationships: SkillRelationshipsState;
      bindings: readonly import("../../domain/assignment-plan").Binding[];
      rootIdentities: Readonly<{ source: string; project: string }>;
    }>
  | Readonly<{ status: "blocked"; code: string; message: string }>;

type SnapshotDependencies = Readonly<{
  registry: RegistryIpcServices;
  relationships: SkillRelationshipStore;
  bindings: BindingsStore;
  filesystem?: SkillObservationFilesystem;
  now?: () => number;
  digest?: (value: string) => string;
}>;

function blocked(code: string, message: string): SkillAdoptionSnapshot {
  return { status: "blocked", code, message };
}

function safeRelative(value: string): boolean {
  return (
    Boolean(value) &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

export function packageSkillArtifactPath(relativeRoot: string, artifactRelativePath: string): string | undefined {
  if (!safeRelative(artifactRelativePath) || artifactRelativePath.split("/").at(-1) !== "SKILL.md") return undefined;
  const packagePath = relativeRoot === "root" ? "" : relativeRoot;
  if (packagePath && !safeRelative(packagePath)) return undefined;
  const artifactPath = packagePath
    ? artifactRelativePath.startsWith(`${packagePath}/`)
      ? artifactRelativePath.slice(packagePath.length + 1)
      : undefined
    : artifactRelativePath;
  if (!artifactPath || !safeRelative(artifactPath)) return undefined;
  const folder = artifactPath.slice(0, -"/SKILL.md".length);
  return safeRelative(folder) ? folder : undefined;
}

export function skillRootIdentity(grant: RegistryGrant, digest: (value: string) => string): string {
  return digest(JSON.stringify([grant.root, grant.device, grant.inode]));
}

function sameSubject(
  grant: RegistryGrant | undefined,
  kind: "source" | "project",
  id: string,
  now: number,
): grant is RegistryGrant {
  return Boolean(grant && grant.subject.kind === kind && grant.subject.id === id && grant.expiresAt > now);
}

export function hasActiveSourceAndProject(
  response: Awaited<ReturnType<RegistryIpcServices["listRegistry"]>>,
  sourceId: string,
  projectId: string,
): boolean {
  if (response.status !== "ready") return false;
  const source = activeWorkshop(response.registry);
  const project = response.registry.projects.find(({ ref }) => ref.id === projectId);
  return (
    source?.ref.id === sourceId &&
    source.availability === "available" &&
    source.archivedAt === undefined &&
    project?.availability === "available" &&
    project.archivedAt === undefined
  );
}

export function observedSourcePath(
  inventory: ObservedSkillEntryResponse["observation"]["inventory"],
  source: SourceSkillRef,
): string | undefined {
  const resolution = resolveObservedPackage(inventory.packages ?? [], source.packageId);
  if (resolution.status === "blocked") return undefined;
  const observedPackage = resolution.package;
  const candidates = inventory.artifacts.filter(
    (artifact) =>
      observedPackage.artifactIds.includes(artifact.id) &&
      (artifact.packageId === undefined || artifact.packageId === observedPackage.id) &&
      artifact.kind === "skill" &&
      packageSkillArtifactPath(observedPackage.relativeRoot, artifact.relativePath) === source.artifactPath,
  );
  if (candidates.length !== 1) return undefined;
  const artifact = candidates[0]!;
  if (
    artifact.projectionPaths.length !== 1 ||
    artifact.projectionPaths[0] !== artifact.relativePath ||
    artifact.symlinkState !== "none" ||
    artifact.scope !== "source"
  )
    return undefined;
  const expected =
    observedPackage.relativeRoot === "root"
      ? `${source.artifactPath}/SKILL.md`
      : `${observedPackage.relativeRoot}/${source.artifactPath}/SKILL.md`;
  return artifact.relativePath === expected ? artifact.relativePath.slice(0, -"/SKILL.md".length) : undefined;
}

export function observedLocalTarget(
  inventory: ObservedSkillEntryResponse["observation"]["inventory"],
  location: SkillLocationKey,
): boolean {
  const expected = `${location.folderPath}/SKILL.md`;
  const candidates = inventory.artifacts.filter(
    (artifact) => artifact.kind === "skill" && artifact.relativePath === expected,
  );
  return (
    candidates.length === 1 &&
    candidates[0]!.projectionPaths.length === 1 &&
    candidates[0]!.projectionPaths[0] === expected &&
    candidates[0]!.symlinkState === "none" &&
    candidates[0]!.scope === "project" &&
    candidates[0]!.providerIds.length === 1 &&
    candidates[0]!.providerIds[0] === location.harnessId
  );
}

export function observationGrant(grant: RegistryGrant): SkillObservationGrant {
  return {
    root: grant.root,
    subject: grant.subject,
    device: grant.device,
    inode: grant.inode,
    expiresAt: grant.expiresAt,
  };
}

function sameBindingState(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function freshGrant(
  registry: RegistryIpcServices,
  ref: Readonly<{ kind: "source" | "project"; id: string }>,
  now: () => number,
): Promise<RegistryGrant | undefined> {
  const handle = await registry.getGrantForEntry(ref);
  if (!handle) return undefined;
  const grant = registry.get(handle);
  return sameSubject(grant, ref.kind, ref.id, now()) ? grant : undefined;
}

export async function captureComplete(
  grant: RegistryGrant,
  folderPath: string,
  budget: SkillScanBudget,
  filesystem: SkillObservationFilesystem,
  digest: (value: string) => string,
): Promise<Extract<SkillTreeCapture, { status: "complete" }> | undefined> {
  const result = await captureSkillTree(observationGrant(grant), folderPath, budget, filesystem, digest);
  return result.status === "complete" ? result : undefined;
}

export async function readSkillAdoptionSnapshot(
  request: SkillAdoptionRequest,
  dependencies: SnapshotDependencies,
): Promise<SkillAdoptionSnapshot> {
  const now = dependencies.now ?? Date.now;
  const filesystem = dependencies.filesystem ?? strictSkillObservationFilesystem;
  const digest = dependencies.digest ?? ((value) => createHash("sha256").update(value, "utf8").digest("hex"));
  const projectId = request.locations[0]?.projectId;
  if (!projectId || request.locations.some((location) => location.projectId !== projectId))
    return blocked("project-scope-invalid", "Adoption locations must refer to one active project.");

  const registryBefore = await dependencies.registry.listRegistry();
  if (
    registryBefore.status === "ready" &&
    activeStorefronts(registryBefore.registry).some((source) => source.ref.id === request.source.sourceId)
  ) {
    const error = new StorefrontTargetError();
    return blocked(error.code, error.message);
  }
  if (!hasActiveSourceAndProject(registryBefore, request.source.sourceId, projectId))
    return blocked("entry-unavailable", "Reopen an active personal source and project before adopting copies.");
  const [sourceGrant, projectGrant] = await Promise.all([
    freshGrant(dependencies.registry, { kind: "source", id: request.source.sourceId }, now),
    freshGrant(dependencies.registry, { kind: "project", id: projectId }, now),
  ]);
  if (!sourceGrant || !projectGrant)
    return blocked("grant-unavailable", "Fresh access to the selected source and project is required.");
  if (!(await currentGrantRoot(sourceGrant)) || !(await currentGrantRoot(projectGrant)))
    return blocked("root-changed", "The registered source or project root changed; reopen it and refresh.");

  const [sourceObservation, projectObservation, relationshipRead, bindingRead] = await Promise.all([
    dependencies.registry.observeEntryWithGrant({ kind: "source", id: request.source.sourceId }, sourceGrant.handle),
    dependencies.registry.observeEntryWithGrant({ kind: "project", id: projectId }, projectGrant.handle),
    dependencies.relationships.read(),
    dependencies.bindings.read(),
  ]);
  if (sourceObservation.status !== "observed")
    return blocked("source-observation-incomplete", "The owned source could not be observed completely.");
  if (
    !hasCompleteObservationForLocation(projectObservation, request.locations[0]!.folderPath) ||
    request.locations.some(({ folderPath }) => !hasCompleteObservationForLocation(projectObservation, folderPath))
  )
    return blocked("observation-incomplete", "Fresh source and project inventories must be complete before adoption.");
  if (relationshipRead.status !== "ready")
    return blocked("relationship-store-unavailable", "The skill relationship store is unavailable or corrupt.");
  if (bindingRead.status !== "ready")
    return blocked("binding-store-unavailable", "The current Binding store is unavailable or corrupt.");
  const sourceRead = readSourceSkillObservation(sourceObservation, request.source, observedSourcePath);
  if (sourceRead.status === "blocked") return sourceRead;
  const sourceFolder = sourceRead.folderPath;
  if (request.locations.some((location) => !observedLocalTarget(projectObservation.observation.inventory, location)))
    return blocked(
      "target-child-ambiguous",
      "A selected conventional target is missing, aliased, provider-managed, or ambiguous.",
    );

  const budget: SkillScanBudget = { remainingBytes: SKILL_SCAN_BUDGET_BYTES };
  const sourceTree = await captureComplete(sourceGrant, sourceFolder, budget, filesystem, digest);
  if (!sourceTree)
    return blocked(
      "source-tree-incomplete",
      "The source skill tree is unsafe, incomplete, or exceeds the observation limits.",
    );
  const localTrees = [] as Array<Extract<SkillAdoptionSnapshot, { status: "ready" }>["localTrees"][number]>;
  for (const location of request.locations) {
    const tree = await captureComplete(projectGrant, location.folderPath, budget, filesystem, digest);
    if (!tree)
      return blocked(
        "target-tree-incomplete",
        "A selected copy is unsafe, incomplete, or exceeds the shared observation limits.",
      );
    localTrees.push({ location, grant: observationGrant(projectGrant), tree });
  }

  const [relationshipAfter, bindingAfter, registryAfter] = await Promise.all([
    dependencies.relationships.read(),
    dependencies.bindings.read(),
    dependencies.registry.listRegistry(),
  ]);
  if (relationshipAfter.status !== "ready" || relationshipAfter.state.revision !== relationshipRead.state.revision)
    return blocked("relationship-store-changed", "Skill relationships changed during adoption preview; refresh it.");
  if (bindingAfter.status !== "ready" || !sameBindingState(bindingRead.bindings, bindingAfter.bindings))
    return blocked("binding-store-changed", "Bindings changed during adoption preview; refresh it.");
  if (
    !hasActiveSourceAndProject(registryAfter, request.source.sourceId, projectId) ||
    sourceGrant.expiresAt <= now() ||
    projectGrant.expiresAt <= now() ||
    !(await currentGrantRoot(sourceGrant)) ||
    !(await currentGrantRoot(projectGrant))
  )
    return blocked(
      "grant-or-root-changed",
      "Source or project access changed during adoption preview; reopen and refresh.",
    );
  if ((await revalidateSkillTree(sourceTree, observationGrant(sourceGrant), filesystem)).status !== "complete")
    return blocked("source-tree-changed", "The source skill tree changed during adoption preview; refresh it.");
  for (const local of localTrees) {
    if ((await revalidateSkillTree(local.tree, local.grant, filesystem)).status !== "complete")
      return blocked("target-tree-changed", "A selected project copy changed during adoption preview; refresh it.");
  }
  return {
    status: "ready",
    sourceGrant,
    projectGrant,
    sourceTree,
    localTrees,
    relationships: relationshipRead.state,
    bindings: bindingRead.bindings,
    rootIdentities: {
      source: skillRootIdentity(sourceGrant, digest),
      project: skillRootIdentity(projectGrant, digest),
    },
  };
}
